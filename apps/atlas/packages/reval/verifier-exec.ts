import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { Channel, isViolation } from './channel.ts';
import { APPLICATION_NAME } from './codes.ts';
import type { FailureCode } from './codes.ts';
import { DeadlineExceeded } from './deadline.ts';
import { verifyFixture } from './fixture-verify.ts';
import { PRIVATE_FRAME_CAP } from './frame.ts';
import { PhysicalAuthError, PhysicalMismatchError, verifyPhysicalEndpoint } from './physical.ts';
import type { PhysicalDeps, QueryClient } from './physical.ts';
import { CHILD_HELLO_V1, decodeFixtureVerifyRequest, FIXTURE_VERIFY_RESULT_V1 } from './private-frames.ts';
import type { FixtureVerifyRequest, FixtureVerifyResult } from './private-frames.ts';
import { SecretFileError } from './secret-file.ts';

/**
 * The short-lived fixture verifier V (rs-b brief B8): spawned by C for ONE FIXTURE_CHECK, empty environment, HELLO first on
 * fd 3 with no credential and no DB; then exactly one verified request; only then the runtime secret file is read and ONE
 * connection is physically bound as the confined runtime role (application `atlas-reval-v-verifier`); one read-only
 * transaction (fixture-verify.ts); one result frame; exit. Parent EOF or its deadline exits at once. It has no bearer, no
 * owner credential, no HTTP surface and no write path.
 */
export const VERIFIER_EXIT = Object.freeze({ OK: 0, DEADLINE: 20, PARENT_LOST: 21, PROTOCOL: 22 });
export const V_CONNECT_TIMEOUT_MS = 300;
export interface VerifierDeps {
  readSecret(path: string): Promise<Buffer>;
  /** Physical verification + connect as the runtime role (production: unix socket only, UTC timestamp decoding). */
  connect(request: FixtureVerifyRequest, password: string, connectTimeoutMs: number, budgetMs: number): Promise<QueryClient>;
}
export function productionVerifierConnect(physical: PhysicalDeps): VerifierDeps['connect'] {
  return async (request, password, connectTimeoutMs, budgetMs) => (await verifyPhysicalEndpoint({ endpoint: request.endpoint, physical: request.physical,
    role: request.runtimeRole, applicationName: APPLICATION_NAME.verifier, budgetMs, connectTimeoutMs }, password, physical)).client;
}
const refused = (challenge: string, code: FailureCode): FixtureVerifyResult => ({ contractVersion: FIXTURE_VERIFY_RESULT_V1, challenge, outcome: 'REFUSED',
  rowIdentity: null, sourceProjection: null, expectedFacts: null, allFiveIntents: null, code });

/** One verification for `request` by `deadline` (absolute on `now`). Never throws. */
export async function runVerifier(request: FixtureVerifyRequest, deadline: number, deps: VerifierDeps, now: () => number): Promise<FixtureVerifyResult> {
  const c = request.challenge;
  let secret: Buffer;
  try { secret = await deps.readSecret(request.runtimeSecretFile); } catch (e) { return refused(c, e instanceof SecretFileError ? 'UNAUTHORIZED' : 'INTERNAL_FAILURE'); }
  let client: QueryClient;
  const remaining = Math.max(1, Math.floor(deadline - now()));
  try { client = await deps.connect(request, secret.toString('latin1'), Math.min(V_CONNECT_TIMEOUT_MS, remaining), remaining); }
  catch (e) {
    return refused(c, e instanceof PhysicalAuthError ? 'OWNER_REQUIRED' : e instanceof PhysicalMismatchError ? 'REGISTRATION_MISMATCH'
      : e instanceof DeadlineExceeded ? 'DEADLINE' : 'INTERNAL_FAILURE');
  } finally { secret.fill(0); }
  // RS-C-A (RS-B N4): an asynchronous server-side termination (idle/statement timeout, admin kill) must not crash V before it
  // answers. The 'error' event is absorbed here; the pending or next query then fails and maps to its fixed refusal.
  const events = client as unknown as { on?(event: 'error', fn: (e: unknown) => void): void };
  events.on?.('error', () => undefined);
  try {
    const out = await verifyFixture(client, request, Math.max(1, Math.floor(deadline - now())));
    if (out.kind === 'REFUSED') return refused(c, out.code);
    return { contractVersion: FIXTURE_VERIFY_RESULT_V1, challenge: c, outcome: 'CHECKED', rowIdentity: out.rowIdentity, sourceProjection: out.sourceProjection,
      expectedFacts: out.expectedFacts, allFiveIntents: out.allFiveIntents, code: null };
  } finally {
    const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream;
    await client.end().catch(() => undefined);
    try { stream?.destroy(); } catch { /* gone */ }
  }
}

/** The V PROCESS (scripts/reval-server/fixture-verifier.ts and test entries). */
export async function runVerifierProcess(deps: VerifierDeps): Promise<never> {
  const now = () => performance.now();
  let fd3ok = false;
  try { fd3ok = fstatSync(3).isSocket(); } catch { fd3ok = false; }
  if (!fd3ok) process.exit(VERIFIER_EXIT.PROTOCOL);
  const channel = new Channel(new Socket({ fd: 3, readable: true, writable: true }), PRIVATE_FRAME_CAP, { strict: true });
  const helloNonce = randomUUID();
  channel.onClose(e => { if (e.reason !== 'LOCAL') process.exit(isViolation(e.reason) ? VERIFIER_EXIT.PROTOCOL : VERIFIER_EXIT.PARENT_LOST); });
  channel.send({ contractVersion: CHILD_HELLO_V1, kind: 'VERIFIER', helloNonce });
  let request: FixtureVerifyRequest;
  try {
    request = decodeFixtureVerifyRequest(await channel.next(1500));
    if (request.helloNonce !== helloNonce) throw new Error('nonce');
  } catch { process.exit(VERIFIER_EXIT.PROTOCOL); }
  const deadline = now() + request!.remainingMs - 50;
  setTimeout(() => process.exit(VERIFIER_EXIT.DEADLINE), Math.max(1, request!.remainingMs - 50)).unref();
  const result = await runVerifier(request!, deadline, deps, now);
  await channel.sendAndFlush(result).catch(() => undefined);
  process.exit(VERIFIER_EXIT.OK);
}
