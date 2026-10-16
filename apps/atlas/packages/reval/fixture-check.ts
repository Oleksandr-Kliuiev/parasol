import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { Channel, ChannelClosed } from './channel.ts';
import type { FailureCode } from './codes.ts';
import type { OwnerConfig } from './config.ts';
import { DATASET_MANIFEST_SHA256, isFixtureId, SEED_MAPPING_SHA256, SYNTHETIC_FRESHNESS_AT } from './dataset.ts';
import { bounded, DeadlineExceeded } from './deadline.ts';
import type { ControllerDeps } from './deps.ts';
import { PRIVATE_FRAME_CAP } from './frame.ts';
import { childPeerOk } from './peer.ts';
import type { FixtureCheckPayload, SnapshotWrapper } from './payloads.ts';
import { decodeChildHello, decodeFixtureVerifyResult, FIXTURE_VERIFY_REQUEST_V1 } from './private-frames.ts';
import type { FixtureVerifyResult } from './private-frames.ts';
import { isPositiveDec64 } from './scalars.ts';

/**
 * FIXTURE_CHECK composition in the controller (rs-b brief B9; 03 "DB equals fixture proof"): ONE budget D = t0 + 1800 ms.
 * (1) reader snapshot #1 (registration/build bound) names the installed fixture and generation; (2) the verifier V is
 * spawned EXACTLY once like E — HELLO, actual peer proof and the request by D − 1200, its result by D − 300; it owns the
 * runtime credential, C never does; (3) reader snapshot #2 by D − 50. #1, V's binding read and #2 must name the SAME fixture
 * and generation (a switch in between changes the generation) and `financeUnchanged` compares the accounting state of #1
 * and #2. rc2 (review F1, 03 "permits only the registered PAUSED synthetic binding"): both snapshots must show the policy
 * PAUSED, else POLICY_CHANGED before/without a positive payload. Only the exact 03 payload or one fixed FAILURE code leaves
 * C. Read-only: no latch, nothing to roll back.
 */
export interface FixtureCheckContext {
  readonly deps: ControllerDeps; readonly config: OwnerConfig;
  /** One bound reader snapshot by `deadline` (absolute on deps.now()): the wrapper, or the reader's fixed failure code. */
  read(deadline: number): Promise<{ w: SnapshotWrapper } | { code: FailureCode }>;
  spawns: number;
  lastChild: ChildProcess | null;
}
export type FixtureCheckDecision = { readonly kind: 'FIXTURE_CHECK'; readonly payload: FixtureCheckPayload } | { readonly kind: 'FAILURE'; readonly code: FailureCode };
const fail = (code: FailureCode): FixtureCheckDecision => ({ kind: 'FAILURE', code });
export const FIXTURE_BUDGET = Object.freeze({ firstReadMs: 450, requestByMs: 1200, resultBeforeEndMs: 300, verifierReserveMs: 350, secondReadBeforeEndMs: 50 });
/** The accounting state compared for financeUnchanged (time/ID/day fields of a snapshot are not accounting). */
const FINANCE_KEYS = ['admissionId', 'policyVersion', 'fenceEpoch', 'policyState', 'reserveMicroUsd', 'dayCapMicroUsd', 'monthCapMicroUsd', 'expiresAt',
  'projectAttemptCount', 'foreignScopeAttemptCount', 'periods', 'attempts', 'consistent'];
const finance = (s: Record<string, unknown>): string => JSON.stringify(FINANCE_KEYS.map(k => s[k]));

export async function fixtureCheck(ctx: FixtureCheckContext, t0: number): Promise<FixtureCheckDecision> {
  const { deps, config } = ctx;
  const D = t0 + 1800;
  const abs = (until: number): number => performance.now() + (until - deps.now());
  const first = await ctx.read(t0 + FIXTURE_BUDGET.firstReadMs);
  if ('code' in first) return fail(first.code);
  const s1 = first.w.snapshot as Record<string, unknown>;
  const fixtureId = s1.fixtureId; const generation = s1.fixtureGeneration;
  if (!isFixtureId(fixtureId) || !isPositiveDec64(generation)) return fail('FIXTURE_MISMATCH');
  if (s1.policyState !== 'PAUSED') return fail('POLICY_CHANGED');
  const child = deps.spawnVerifier(); ctx.spawns += 1; ctx.lastChild = child;
  const channel = new Channel(child.stdio[3] as Socket, PRIVATE_FRAME_CAP, { strict: true });
  let result: FixtureVerifyResult;
  try {
    const requestBy = D - FIXTURE_BUDGET.requestByMs;
    let hello;
    try { hello = decodeChildHello(await channel.next(Math.min(1000, Math.max(0, requestBy - deps.now())))); }
    catch (e) { return fail(e instanceof ChannelClosed && e.reason === 'TIMEOUT' ? 'DEADLINE' : 'IDENTITY_UNVERIFIED'); }
    if (hello.kind !== 'VERIFIER' || child.pid === undefined) return fail('IDENTITY_UNVERIFIED');
    const facts = await bounded(deps.peer(config.nativePeerHelper, child.stdio[3] as Socket, deps.nodeRealpath), abs(requestBy))
      .catch((e: unknown) => (e instanceof DeadlineExceeded ? 'DEADLINE' as const : null));
    if (facts === 'DEADLINE') return fail('DEADLINE');
    if (!facts || !childPeerOk(facts, child.pid) || child.exitCode !== null || child.signalCode !== null || channel.violated() || channel.closed) {
      return fail('IDENTITY_UNVERIFIED');
    }
    const now = deps.now();
    const remainingMs = Math.min(1400, Math.floor(D - FIXTURE_BUDGET.verifierReserveMs - now));
    if (now > requestBy || remainingMs < 1) return fail('DEADLINE');
    const challenge = randomUUID();
    try {
      channel.send({ contractVersion: FIXTURE_VERIFY_REQUEST_V1, helloNonce: hello.helloNonce, challenge, remainingMs, registrationId: config.registrationId,
        databaseInstanceId: config.databaseInstanceId, workspaceId: config.workspaceId, clientId: config.clientId, actorId: config.actorId,
        admissionId: config.admissionId, fixtureId, fixtureGeneration: generation, endpoint: config.endpoint, runtimeRole: config.roles.runtime,
        physical: config.physical, runtimeSecretFile: config.secretFiles.runtime });
    } catch { return fail('FIXTURE_MISMATCH'); }
    try { result = decodeFixtureVerifyResult(await channel.next(Math.max(0, D - FIXTURE_BUDGET.resultBeforeEndMs - deps.now()))); }
    catch (e) { return fail(e instanceof ChannelClosed && e.reason === 'TIMEOUT' ? 'DEADLINE' : 'FIXTURE_MISMATCH'); }
    if (channel.violated() || result.challenge !== challenge) return fail('FIXTURE_MISMATCH');
  } finally { channel.close(); }
  if (result.outcome === 'REFUSED') return fail(result.code!);
  const second = await ctx.read(D - FIXTURE_BUDGET.secondReadBeforeEndMs);
  if ('code' in second) return fail(second.code);
  const s2 = second.w.snapshot as Record<string, unknown>;
  if (s2.fixtureId !== fixtureId || s2.fixtureGeneration !== generation) return fail('FIXTURE_MISMATCH');
  if (s2.policyState !== 'PAUSED') return fail('POLICY_CHANGED');
  return { kind: 'FIXTURE_CHECK', payload: { fixtureId, fixtureGeneration: generation, datasetManifestSha256: DATASET_MANIFEST_SHA256,
    seedMappingSha256: SEED_MAPPING_SHA256, syntheticFreshnessAt: SYNTHETIC_FRESHNESS_AT, sourceMode: 'db', rowIdentity: result.rowIdentity!,
    sourceProjection: result.sourceProjection!, expectedFacts: result.expectedFacts!, allFiveIntents: result.allFiveIntents!,
    financeUnchanged: finance(s1) === finance(s2), realTimeFreshnessClaim: false } };
}
