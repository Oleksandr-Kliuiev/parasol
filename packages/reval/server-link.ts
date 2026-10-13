import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Socket } from 'node:net';
import { Channel, isViolation } from './channel.ts';
import { APPLICATION_NAME, SERVER_INNER_ACK_REF } from './codes.ts';
import type { FailureCode } from './codes.ts';
import type { OwnerConfig } from './config.ts';
import { bounded } from './deadline.ts';
import type { ControllerDeps } from './deps.ts';
import { buildRequest, checkResponse, decodeResponse, Sequence } from './envelope.ts';
import type { ConnectionBinding } from './envelope.ts';
import { METADATA_FRAME_CAP, PRIVATE_FRAME_CAP } from './frame.ts';
import { awaitExit } from './launch.ts';
import { decodeIdentity } from './payloads.ts';
import { childPeerOk, sameIncarnation } from './peer.ts';
import type { PeerFacts } from './peer.ts';
import type { Observed, QueryClient } from './physical.ts';
import { sandboxEnforced } from './platform.ts';
import type { SandboxFacts } from './platform.ts';
import { decodeChildHello, decodeServerBound } from './private-frames.ts';
import { PAIR_SECRET_V1, SERVER_LAUNCH_V2 } from './eval-wire.ts';
import type { Kind, Operation } from './codes.ts';

/**
 * The controller's link to its ONE server child S (brief §2e/§3): HELLO first → actual peer proof → private launch frame
 * (paths/expectations only, never credentials) → S's own physical binding and readiness → RevalServerBoundV1 compared with
 * the reader's tuple and (when visible) pg_stat_activity → 06 IDENTITY seq1 and seq2, after which S listens. Any mismatch
 * kills S before it listens. EVERY later IDENTITY re-proves the same pid AND pidversion. S death → LOST, no relaunch.
 */
export type ServerState = 'LAUNCHING' | 'READY' | 'LOST';
export class ServerLink {
  state: ServerState = 'LAUNCHING';
  /** pg_stat_activity cross-check of S's bound backend: VERIFIED, or UNAVAILABLE when PG hides the row from the reader. */
  activityCheck: 'PENDING' | 'VERIFIED' | 'UNAVAILABLE' = 'PENDING';
  facts: PeerFacts | null = null;
  /** RS-D-B: the helper's Seatbelt answer for S's pid, checked before S listens (S runs only under the pinned profile). */
  sandbox: SandboxFacts | null = null;
  /** RS-D-B: when C saw S verified (the platform proof interval starts here). */
  verifiedAt: string | null = null;
  readonly ready: Promise<boolean>;
  private child: ChildProcess | null = null;
  private channel: Channel | null = null;
  private readonly binding: ConnectionBinding;
  private readonly send = new Sequence();
  private readonly recv = new Sequence();
  private readonly deps: ControllerDeps; private readonly config: OwnerConfig;
  private readonly reader: () => { client: QueryClient; observed: Observed } | null;
  /** RS-C-A: the owner's handoff socket path S listens on (inside the owner config's 0700 directory). */
  private readonly handoffSocketPath: string;
  /** RS-D-C: the owner config file (S's profile denies writing it, C's journal and C's instrument socket next to it). */
  private readonly configPath: string;
  constructor(deps: ControllerDeps, config: OwnerConfig, serverBootId: string, reader: () => { client: QueryClient; observed: Observed } | null,
    configPath: string) {
    this.deps = deps; this.config = config; this.reader = reader; this.configPath = configPath;
    this.handoffSocketPath = join(dirname(configPath), 'reval-handoff.sock');
    this.binding = { registrationId: config.registrationId, serverBootId, connectionId: randomUUID() };
    this.ready = this.launch().then(ok => { if (!ok) this.kill(); return ok; }, () => { this.kill(); return false; });
  }
  private async launch(): Promise<boolean> {
    const child = this.child = this.deps.spawnServer(this.config, this.configPath);
    child.once('exit', () => { this.state = 'LOST'; this.channel?.close(); });
    // Strict private channel (§2e): a duplicate HELLO/Bound, a frame before HELLO or any unsolicited frame closes it → S killed.
    const channel = this.channel = new Channel(child.stdio[3] as Socket, PRIVATE_FRAME_CAP, { strict: true });
    channel.onClose(e => { if (isViolation(e.reason)) this.kill(); });
    const hello = decodeChildHello(await channel.next(1000));
    if (hello.kind !== 'SERVER' || !await this.prove() || channel.closed) return false;
    // RS-D-B: S must run under the pinned profile (inherited by descendants; IP egress only to localhost) before it gets the launch frame.
    const pid = this.facts!.pid;
    const sandbox = await this.deps.sandboxCheck(this.config.nativePeerHelper, pid).catch(() => null);
    if (!sandboxEnforced(sandbox, pid) || channel.closed) return false;
    this.sandbox = sandbox;
    const launchChallenge = randomUUID();
    channel.send({ contractVersion: SERVER_LAUNCH_V2, registrationId: this.config.registrationId, databaseInstanceId: this.config.databaseInstanceId,
      serverBootId: this.binding.serverBootId, connectionId: this.binding.connectionId, launchChallenge, endpoint: this.config.endpoint,
      runtimeRole: this.config.roles.runtime, runtimeSecretFile: this.config.secretFiles.runtime, physical: this.config.physical,
      workspaceId: this.config.workspaceId, askMode: 'remote', handoffSocketPath: this.handoffSocketPath, nativePeerHelper: this.config.nativePeerHelper,
      nativePeerHelperSha256: this.config.nativePeerHelperSha256 });
    const bound = decodeServerBound(await channel.next(30000));
    const reader = this.reader();
    if (!reader || bound.launchChallenge !== launchChallenge || bound.serverBootId !== this.binding.serverBootId
      || bound.observed.systemIdentifier !== reader.observed.systemIdentifier || bound.observed.databaseOid !== reader.observed.databaseOid
      || bound.observed.postmasterStartTime !== reader.observed.postmasterStartTime || bound.observed.sessionUser !== this.config.roles.runtime) return false;
    const seen = await reader.client.query(`SELECT usename::text AS u, application_name AS a, datname::text AS d, datname = pg_catalog.current_database() AS same
      FROM pg_catalog.pg_stat_activity WHERE pid = $1::int`, [bound.observed.backendPid]);
    if (seen.rows.length === 0) this.activityCheck = 'UNAVAILABLE';
    else if (seen.rows[0]!.u === this.config.roles.runtime && seen.rows[0]!.a === APPLICATION_NAME.runtime && seen.rows[0]!.same === true) this.activityCheck = 'VERIFIED';
    else return false;
    channel.switchCap(METADATA_FRAME_CAP);
    for (let i = 0; i < 2; i += 1) if (await this.identityRequest(5000) === null) return false;
    this.state = this.child.exitCode === null ? 'READY' : 'LOST';
    if (this.state === 'READY') this.verifiedAt = new Date(this.deps.wallIso()).toISOString();
    return this.state === 'READY';
  }
  /** Actual peer proof of S on C's channel end: exact child pid, parent C, euid, exe, no TTY, same incarnation, alive after. */
  private async prove(): Promise<boolean> {
    const child = this.child; const socket = child?.stdio[3] as Socket | undefined;
    if (!child || !socket || child.pid === undefined) return false;
    const facts = await this.deps.peer(this.config.nativePeerHelper, socket, this.deps.nodeRealpath).catch(() => null);
    if (!facts || !childPeerOk(facts, child.pid) || child.exitCode !== null || child.signalCode !== null) return false;
    if (this.facts && !sameIncarnation(this.facts, facts)) return false;
    this.facts = facts;
    return true;
  }
  /** One 06 IDENTITY C→S exchange; returns S's (non-evidence) payload or null. */
  private async identityRequest(timeoutMs: number): Promise<unknown | null> {
    const channel = this.channel; if (!channel || channel.closed) return null;
    const out = { challenge: randomUUID(), sequence: this.send.take(), operation: 'IDENTITY' as const };
    channel.send(buildRequest(this.binding, out.challenge, out.sequence, 'IDENTITY', {}));
    try {
      const r = decodeResponse(await channel.next(timeoutMs));
      if (checkResponse(this.binding, this.recv, out, r, 'SERVER', this.config.databaseInstanceId) !== null || r.kind !== 'IDENTITY') return null;
      const p = decodeIdentity(r.payload);
      if (p.loadedBinding !== 'UNVERIFIED' || p.platformEvidenceRef !== SERVER_INNER_ACK_REF || p.databaseInstanceId !== this.config.databaseInstanceId) return null;
      return p;
    } catch { return null; }
  }
  /**
   * RS-C-A: one restricted C→S evaluation request (END_PAIR, ARM_CASE, TERMINAL_OBSERVATION, OBSERVATION_COLLECTED, or the PAIR
   * install as the exact RevalPairSecretV1 frame with requestSequence === sequence). The response must be authenticated on this
   * channel with emitter SERVER and the expected kind (or FAILURE); anything else is null. The caller serializes operations.
   */
  async evaluationRequest(operation: Operation, payload: Record<string, unknown>, timeoutMs: number,
    secret?: { pairId: string; instrumentControlConnectionId: string; instrumentHandoffConnectionId: string; pairingNonce: string; expiresAt: string }):
    Promise<{ kind: Kind; payload: unknown } | null> {
    const channel = this.channel;
    if (!channel || channel.closed || this.state !== 'READY') return null;
    const out = { challenge: randomUUID(), sequence: this.send.take(), operation };
    if (secret) {
      channel.send({ contractVersion: PAIR_SECRET_V1, registrationId: this.binding.registrationId, serverBootId: this.binding.serverBootId,
        connectionId: this.binding.connectionId, sequence: out.sequence, challenge: out.challenge, requestSequence: out.sequence, ...secret });
    } else channel.send(buildRequest(this.binding, out.challenge, out.sequence, operation, payload));
    try {
      const r = decodeResponse(await channel.next(timeoutMs));
      if (checkResponse(this.binding, this.recv, out, r, 'SERVER', this.config.databaseInstanceId) !== null) { this.kill(); return null; }
      return { kind: r.kind, payload: r.payload };
    } catch { this.kill(); return null; }
  }
  /** IDENTITY for O: null = ready and re-proven (facts current); otherwise the fixed failure. Kills S on a mismatch. */
  async identity(deadline: number): Promise<FailureCode | null> {
    if (this.state === 'LAUNCHING') {
      const left = deadline - this.deps.now() - 150;
      if (left > 0) await Promise.race([this.ready, new Promise(r => setTimeout(r, left))]);
    }
    if (this.state !== 'READY') return 'IDENTITY_UNVERIFIED';
    const at = (t: number) => performance.now() + (t - this.deps.now());
    const proven = await bounded(this.prove(), at(deadline - 100)).catch(() => false);
    const left = deadline - this.deps.now() - 20;
    const ok = proven && left >= 1 && await this.identityRequest(left) !== null;
    if (!ok || this.child?.exitCode !== null) { this.kill(); return 'IDENTITY_UNVERIFIED'; }
    return null;
  }
  /** The server child's pid (excluded from instrument peer identities), or null. */
  get pid(): number | null { return this.child?.pid ?? null; }
  /** RS-D-B: S is READY, still the verified incarnation (never exited) and its pid is sandboxed with the profile's resolver deny NOW. */
  async enforcedNow(): Promise<boolean> {
    const pid = this.facts?.pid ?? null;
    if (this.state !== 'READY' || pid === null || pid !== this.child?.pid || this.child.exitCode !== null) return false;
    const f = await this.deps.sandboxCheck(this.config.nativePeerHelper, pid).catch(() => null);
    return sandboxEnforced(f, pid) && this.state === 'READY';
  }
  /** SIGTERM (then SIGKILL after `graceMs`) and reap. */
  async stop(graceMs: number): Promise<void> {
    const child = this.child; if (!child) return;
    this.state = 'LOST'; this.channel?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await awaitExit(child, graceMs)) { child.kill('SIGKILL'); await awaitExit(child, 1000); }
  }
  kill(): void {
    this.state = 'LOST'; this.channel?.close();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}
