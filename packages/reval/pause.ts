import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { Channel } from './channel.ts';
import { afterRequest, beforeRequestFailure, closureAfterReread, pauseDeadlines, remainingForExecutor } from './closure.ts';
import type { PauseDecision, Reread } from './closure.ts';
import type { OwnerConfig } from './config.ts';
import { bounded, DeadlineExceeded } from './deadline.ts';
import type { ControllerDeps } from './deps.ts';
import { PRIVATE_FRAME_CAP } from './frame.ts';
import { awaitExit } from './launch.ts';
import { childPeerOk } from './peer.ts';
import { decodeChildHello, decodeOwnerExecResult, OWNER_EXEC_REQUEST_V1 } from './private-frames.ts';
import type { OwnerExecResult } from './private-frames.ts';
import type { SnapshotWrapper } from './payloads.ts';
import { snapshotFitsEnvelope } from './snapshot-reader.ts';

/**
 * PAUSE_EXPORT orchestration in the controller (brief §6): one budget D = t0 + 1800 ms; E spawned EXACTLY once; HELLO,
 * actual peer proof and the request by D − 1200; E's result by DE = D − 400; ONE reread by D − 50. The owner credential
 * never enters C (only its file path is forwarded). Cleanup is bounded separately (SIGKILL + reap ≤ 1000 ms) after the
 * decision. The session latch makes every later PAUSE_EXPORT fail without spawning. Killing E never proves rollback.
 */
export interface PauseContext {
  readonly deps: ControllerDeps; readonly config: OwnerConfig;
  /** The single reread (null on ANY failure: RV code, timeout, physical/build binding); pauseExport applies the byte cap. */
  reread(deadline: number): Promise<SnapshotWrapper | null>;
  latched: boolean;
  /** Test/evidence counter of executor spawns in this session. */
  spawns: number;
  /** The executor child of the last invocation (for bounded cleanup). */
  lastChild: ChildProcess | null;
  /** Whether the current invocation already sent its request frame (from then on any non-result is commit-uncertain). */
  requestSent: boolean;
}
const fail = (code: 'CONTAINMENT_UNCONFIRMED', latch: true): PauseDecision => ({ kind: 'FAILURE', code, latch });
export interface PauseRequest { readonly admissionId: string; readonly expectedPolicyVersion: string; readonly policyFloor: string; readonly fenceFloor: string }

export async function pauseExport(ctx: PauseContext, req: PauseRequest, t0: number): Promise<PauseDecision> {
  const { deps, config } = ctx;
  if (req.admissionId !== config.admissionId) return { kind: 'FAILURE', code: 'REGISTRATION_MISMATCH', latch: false };
  if (ctx.latched) return { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: false };
  const d = pauseDeadlines(t0);
  ctx.requestSent = false;
  const abs = (until: number): number => performance.now() + (until - deps.now());
  const child = deps.spawnExecutor(); ctx.spawns += 1; ctx.lastChild = child;
  // Strict private channel (§2e): a duplicate/coalesced HELLO or result, or any unsolicited frame, closes it with PROTOCOL.
  const channel = new Channel(child.stdio[3] as Socket, PRIVATE_FRAME_CAP, { strict: true });
  /** Ends listening to E at the moment of the decision (no await in between): nothing E sends later can be attributed. */
  const closeAnd = (d: PauseDecision): PauseDecision => { channel.close(); return d; };
  const decision = await (async (): Promise<PauseDecision> => {
    // Phase 1 — before the request frame: no commit is possible.
    let hello;
    try { hello = decodeChildHello(await channel.next(Math.min(1000, d.requestBy - deps.now()))); } catch { return beforeRequestFailure(false); }
    if (hello.kind !== 'EXECUTOR' || child.pid === undefined) return beforeRequestFailure(true);
    // The proof must complete by requestBy; running out of that budget is DEADLINE (§6 table), an actual mismatch IDENTITY_UNVERIFIED.
    const facts = await bounded(deps.peer(config.nativePeerHelper, child.stdio[3] as Socket, deps.nodeRealpath), abs(d.requestBy))
      .catch((e: unknown) => (e instanceof DeadlineExceeded ? 'DEADLINE' as const : null));
    if (facts === 'DEADLINE') return beforeRequestFailure(false);
    if (!facts || !childPeerOk(facts, child.pid) || child.exitCode !== null || child.signalCode !== null) return beforeRequestFailure(true);
    // A second HELLO (or anything else) received before the request: protocol violation, nothing was sent, no latch.
    if (channel.violated() || channel.closed) return beforeRequestFailure(true);
    const now = deps.now();
    const remainingMs = remainingForExecutor(d.DE, now);
    if (now > d.requestBy || remainingMs === null) return beforeRequestFailure(false);
    const challenge = randomUUID();
    try {
      ctx.requestSent = true;
      channel.send({ contractVersion: OWNER_EXEC_REQUEST_V1, helloNonce: hello.helloNonce, challenge, remainingMs,
        registrationId: config.registrationId, databaseInstanceId: config.databaseInstanceId, workspaceId: config.workspaceId,
        clientId: config.clientId, actorId: config.actorId, admissionId: config.admissionId, expectedPolicyVersion: req.expectedPolicyVersion,
        endpoint: config.endpoint, ownerRole: config.roles.owner, physical: config.physical, ownerSecretFile: config.secretFiles.owner });
    } catch { ctx.requestSent = false; return beforeRequestFailure(false); }
    // Phase 2 — the request was sent: anything but a valid authenticated result is commit-uncertain (latch).
    let result: OwnerExecResult | null = null;
    try { result = decodeOwnerExecResult(await channel.next(Math.max(0, d.DE - deps.now()))); } catch { result = null; }
    // A duplicate/extra frame with (or after) the result: the result is not authenticated as THE single outcome → uncertain.
    if (channel.violated()) result = null;
    const after = afterRequest(result, challenge);
    if ('kind' in after) return after;
    // The single reread; the same reader-level byte cap as SNAPSHOT applies (over cap after a confirmed commit → latch).
    // The strict channel stays open (unsolicited) during this await, so ANY later traffic from E — a duplicate or extra result,
    // a partial, malformed or oversize frame — closes it as a violation; its normal EOF/exit does not.
    const got = await ctx.reread(d.rereadBy).catch(() => null);
    // Re-checked AFTER the reread and, in the same synchronous step, the channel is closed: a violation received at any time
    // until the decision means the single outcome is not authenticated → CONTAINMENT_UNCONFIRMED + latch, never a closure.
    if (channel.violated()) return closeAnd(fail('CONTAINMENT_UNCONFIRMED', true));
    const w = got !== null && snapshotFitsEnvelope(got) ? got : null;
    const reread: Reread | null = w === null ? null : { admissionId: w.snapshot.admissionId as string, policyState: w.snapshot.policyState as string,
      policyVersion: w.snapshot.policyVersion as string, fenceEpoch: w.snapshot.fenceEpoch as string };
    return closeAnd(closureAfterReread(config.admissionId, after, reread, { policyFloor: req.policyFloor, fenceFloor: req.fenceFloor }));
  })();
  if (decision.kind === 'FAILURE' && decision.latch) ctx.latched = true;
  channel.close();
  return decision;
}
/** Bounded cleanup after the response: SIGKILL a live executor and reap it (≤ 1000 ms). */
export async function reapExecutor(child: ChildProcess | null): Promise<boolean> {
  if (!child) return true;
  if (child.exitCode === null && child.signalCode === null && !await awaitExit(child, 100)) child.kill('SIGKILL');
  return awaitExit(child, 1000);
}
