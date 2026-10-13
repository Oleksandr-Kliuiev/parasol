import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import pg from 'pg';
import { Channel, isViolation } from '../../../../packages/reval/channel.ts';
import { APPLICATION_NAME, authorize, NOT_IMPLEMENTED, SERVER_INNER_ACK_REF } from '../../../../packages/reval/codes.ts';
import type { FailureCode, Kind } from '../../../../packages/reval/codes.ts';
import { buildResponse, decodeRequest, ResponderState } from '../../../../packages/reval/envelope.ts';
import type { Request } from '../../../../packages/reval/envelope.ts';
import { METADATA_FRAME_CAP, PRIVATE_FRAME_CAP } from '../../../../packages/reval/frame.ts';
import { nodePhysicalDeps, verifyPhysicalEndpoint } from '../../../../packages/reval/physical.ts';
import type { Observed, QueryClient } from '../../../../packages/reval/physical.ts';
import { CHILD_HELLO_V1, SERVER_BOUND_V1 } from '../../../../packages/reval/private-frames.ts';
import { decodePairSecret, decodeServerLaunchV2, PAIR_SECRET_V1 } from '../../../../packages/reval/eval-wire.ts';
import type { ServerLaunchV2 } from '../../../../packages/reval/eval-wire.ts';
import type { EvaluationRuntime } from '../../../../packages/reval/eval-runtime.ts';
import { readSecretFile } from '../../../../packages/reval/secret-file.ts';

/**
 * R-EVAL RS-A server bridge (docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md §2e/§3). Active ONLY when the
 * controller launched this API with ATLAS_REVAL_BRIDGE_FD=3; otherwise main.ts never loads it into use. Order: refuse any
 * other mode (db only, Ask OFF, no operator UI, no ATLAS_RUNTIME_DATABASE_URL, fd 3 a socket) → HELLO first (no credential,
 * no DB) → the controller's launch frame → read the closed runtime password → physical binding over the unix socket →
 * the runtime URL composed IN MEMORY for connectRuntimeDatabase(url) (never written to env) → RevalServerBoundV1 from this
 * process's own query → answer verified IDENTITY seq1 and seq2 → only then main.ts listens. Bridge loss exits immediately.
 * RS-C-A: the launch frame is RevalServerLaunchV2 (registered workspace, Ask REMOTE, handoff socket path, pinned helper); the
 * attached EvaluationRuntime answers C's restricted PAIR install (RevalPairSecretV1), END_PAIR, ARM_CASE, TERMINAL_OBSERVATION
 * and OBSERVATION_COLLECTED; RS-D-A adds PROCESS_CENSUS (the guard census); every other non-IDENTITY operation stays fail-closed.
 */
/**
 * RS-C-A adds REGISTRATION: the launch's registration/helper does not match (composeEvaluation), before S listens. RS-C-C adds
 * CONSOLE: the sealed measured console assets are missing or inconsistent with their manifest, before S listens.
 */
export const BRIDGE_EXIT = Object.freeze({ REFUSED: 40, CONTROLLER_LOST: 41, LAUNCH: 42, REGISTRATION: 43, CONSOLE: 44 });
/**
 * The environment exactly as the controller supplied it, captured when this module is evaluated: main.ts imports the
 * bridge FIRST, before @prisma/client, whose import loads a checkout `.env` into process.env. The URL-absence check applies
 * to this parent-supplied snapshot (the env URL is never used in bridge mode); Ask/UI must be off in BOTH snapshots so a
 * file-injected value cannot switch them on.
 */
const LAUNCH_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });
const off = (env: Readonly<Record<string, string | undefined>>) =>
  (env.ATLAS_ASK_MODE === undefined || env.ATLAS_ASK_MODE === 'off') && env.ATLAS_OPERATOR_UI === undefined;
export interface BridgeDeps {
  readSecret(path: string): Promise<Buffer>;
  /** Physical binding + connect as the runtime role (production: unix socket only). */
  verify(launch: ServerLaunchV2, password: string): Promise<{ client: QueryClient; observed: Observed }>;
  /** The runtime URL handed to connectRuntimeDatabase (production: the same unix socket endpoint). */
  runtimeUrl(launch: ServerLaunchV2, password: string): string;
}
const unixUrl = (l: ServerLaunchV2, password: string): string =>
  `postgresql://${encodeURIComponent(l.runtimeRole)}:${encodeURIComponent(password)}@localhost:${l.endpoint.port}/${encodeURIComponent(l.endpoint.database)}`
  + `?host=${encodeURIComponent(l.endpoint.socketDir)}&application_name=${APPLICATION_NAME.runtime}`;
export function productionBridgeDeps(): BridgeDeps {
  const physical = nodePhysicalDeps(async o => { const c = new pg.Client(o); await c.connect(); return c as unknown as QueryClient; });
  return {
    readSecret: readSecretFile,
    verify: (l, password) => verifyPhysicalEndpoint({ endpoint: l.endpoint, physical: l.physical, role: l.runtimeRole,
      applicationName: APPLICATION_NAME.runtime, budgetMs: 2000 }, password, physical),
    runtimeUrl: unixUrl,
  };
}
const ZERO = '0'.repeat(64);

export class RevalBridge {
  readonly runtimeUrl: string;
  private readonly channel: Channel; readonly launch: ServerLaunchV2; private readonly observed: Observed;
  private runtime: EvaluationRuntime | null = null;
  private bindingClient: QueryClient | null;
  private readonly startedAt = new Date().toISOString();
  private constructor(channel: Channel, launch: ServerLaunchV2, verified: { client: QueryClient; observed: Observed }, url: string) {
    this.channel = channel; this.launch = launch; this.observed = verified.observed; this.bindingClient = verified.client; this.runtimeUrl = url;
  }
  /** Validates the bridge-only mode, sends HELLO, receives the launch frame and binds the runtime database physically. */
  static async start(env: Readonly<Record<string, string | undefined>> = LAUNCH_ENV, deps: BridgeDeps = productionBridgeDeps()): Promise<RevalBridge> {
    let socket = false;
    try { socket = fstatSync(3).isSocket(); } catch { socket = false; }
    if (env.ATLAS_REVAL_BRIDGE_FD !== '3' || env.ATLAS_MODE !== 'db' || process.env.ATLAS_MODE !== 'db' || !off(env) || !off(process.env)
      || env.ATLAS_RUNTIME_DATABASE_URL !== undefined || !socket) process.exit(BRIDGE_EXIT.REFUSED);
    // Strict private channel (§2e): a duplicate/coalesced/fragmented launch frame or any unsolicited frame exits at once,
    // inside the receiving `data` event — before the secret read or any connection of an earlier frame's continuation.
    const channel = new Channel(new Socket({ fd: 3, readable: true, writable: true }), PRIVATE_FRAME_CAP, { strict: true });
    channel.onClose(e => { if (e.reason !== 'LOCAL') process.exit(isViolation(e.reason) ? BRIDGE_EXIT.LAUNCH : BRIDGE_EXIT.CONTROLLER_LOST); });
    channel.send({ contractVersion: CHILD_HELLO_V1, kind: 'SERVER', helloNonce: randomUUID() });
    try {
      const launch = decodeServerLaunchV2(await channel.next(2000));
      const secret = await deps.readSecret(launch.runtimeSecretFile);
      const password = secret.toString('latin1'); secret.fill(0);
      const verified = await deps.verify(launch, password);
      return new RevalBridge(channel, launch, verified, deps.runtimeUrl(launch, password));
    } catch { process.exit(BRIDGE_EXIT.LAUNCH); }
  }
  /** RS-C-A: the registered evaluation hub answering C's restricted evaluation operations (set before the bridge opens). */
  attach(runtime: EvaluationRuntime): void { this.runtime = runtime; }
  /** After the runtime readiness passed: report the bound tuple, answer IDENTITY seq1 and seq2, then keep answering. */
  async bindAndAwaitOpen(): Promise<void> {
    const l = this.launch;
    const state = new ResponderState({ registrationId: l.registrationId, serverBootId: l.serverBootId, connectionId: l.connectionId });
    try {
      this.channel.send({ contractVersion: SERVER_BOUND_V1, launchChallenge: l.launchChallenge, serverBootId: l.serverBootId, observed: this.observed });
      this.channel.switchCap(METADATA_FRAME_CAP);
      for (let i = 0; i < 2; i += 1) {
        const d = decodeRequest(await this.channel.next(5000));
        if (!d.ok || state.check(d.request) !== null || d.request.operation !== 'IDENTITY') throw new Error('open');
        this.respond(state, d.request, 'IDENTITY', this.identity());
      }
    } catch { process.exit(BRIDGE_EXIT.LAUNCH); }
    // Serve FIRST (its next() is registered synchronously), so a prompt C request is never unsolicited on the strict channel.
    void this.serve(state);
    await this.bindingClient?.end().catch(() => undefined); this.bindingClient = null;
  }
  private identity() {
    return { databaseInstanceId: this.launch.databaseInstanceId, buildManifestSha256: ZERO, runtimeImageSha256: ZERO, launcherManifestSha256: ZERO,
      platformEvidenceRef: SERVER_INNER_ACK_REF, loadedBinding: 'UNVERIFIED', startedAt: this.startedAt };
  }
  private respond(state: ResponderState, r: { challenge: string; sequence: string }, kind: Kind, payload: unknown): void {
    this.channel.send(buildResponse(state.binding, r, state.send.take(), 'SERVER', this.launch.databaseInstanceId, kind, payload, new Date().toISOString()));
  }
  /**
   * Later C→S requests, one at a time: IDENTITY; RS-C-A evaluation operations through the attached runtime (PAIR install is the
   * exact RevalPairSecretV1 restricted request with requestSequence === sequence); every other operation fail-closed.
   */
  private async serve(state: ResponderState): Promise<void> {
    for (;;) {
      let value: unknown;
      try { value = await this.channel.next(); } catch { process.exit(BRIDGE_EXIT.CONTROLLER_LOST); }
      if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).contractVersion === PAIR_SECRET_V1) {
        this.installPair(state, value);
        continue;
      }
      const d = decodeRequest(value);
      if (!d.ok) { if (d.addressable) this.respond(state, d.addressable, 'FAILURE', { code: 'PROTOCOL_INVALID' }); this.channel.close(); process.exit(BRIDGE_EXIT.CONTROLLER_LOST); }
      const r: Request = d.request;
      const problem: FailureCode | null = state.check(r) ?? authorize('C', 'S', r.operation) ?? NOT_IMPLEMENTED[r.operation] ?? null;
      if (problem) { this.respond(state, r, 'FAILURE', { code: problem }); continue; }
      if (r.operation === 'IDENTITY') { this.respond(state, r, 'IDENTITY', this.identity()); continue; }
      const rt = this.runtime;
      if (!rt) { this.respond(state, r, 'FAILURE', { code: 'PAIR_UNAVAILABLE' }); continue; }
      const p = r.payload as Record<string, string & number>;
      if (r.operation === 'END_PAIR') { const a = rt.endPair(p.pairId); this.answer(state, r, 'PAIR_ACK', a); continue; }
      if (r.operation === 'ARM_CASE') {
        const a = await rt.armCase(p as never);
        this.answer(state, r, 'ARM_ACK', a); continue;
      }
      if (r.operation === 'TERMINAL_OBSERVATION') { this.answer(state, r, 'TERMINAL_OBSERVATION', rt.terminal(p.armId)); continue; }
      if (r.operation === 'PROCESS_CENSUS') { this.answer(state, r, 'PROCESS_CENSUS', rt.processCensus()); continue; }
      if (r.operation === 'OBSERVATION_COLLECTED') {
        const ok = rt.collected(p.armId, p.observationId, p.revision);
        this.answer(state, r, 'OBSERVATION_ACK', ok ? { armId: p.armId, observationId: p.observationId, revision: p.revision, collected: true } : 'OBSERVATION_UNAVAILABLE');
        continue;
      }
      this.respond(state, r, 'FAILURE', { code: 'WRONG_DIRECTION' });
    }
  }
  private answer(state: ResponderState, r: { challenge: string; sequence: string }, kind: Kind, value: unknown): void {
    if (typeof value === 'string') this.respond(state, r, 'FAILURE', { code: value }); else this.respond(state, r, kind, value);
  }
  /** The restricted PAIR install: exact secret frame, current C→S binding/sequence, requestSequence === sequence, ≤2 KiB. */
  private installPair(state: ResponderState, value: unknown): void {
    let secret;
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2048) throw new Error('size');
      secret = decodePairSecret(value);
    } catch { this.channel.close(); process.exit(BRIDGE_EXIT.CONTROLLER_LOST); }
    const r = { contractVersion: 'RevalOwnerCommandV1', registrationId: secret.registrationId, serverBootId: secret.serverBootId,
      connectionId: secret.connectionId, challenge: secret.challenge, sequence: secret.sequence, operation: 'PAIR', payload: {} } as unknown as Request;
    const problem = state.check(r) ?? (secret.requestSequence !== secret.sequence ? 'SEQUENCE_INVALID' : null);
    if (problem) { this.respond(state, r, 'FAILURE', { code: problem }); return; }
    const a = this.runtime ? this.runtime.installPair(secret) : 'PAIR_UNAVAILABLE';
    this.answer(state, r, 'PAIR_ACK', a);
  }

}
