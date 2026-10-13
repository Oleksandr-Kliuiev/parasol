import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { fstatSync } from 'node:fs';
import { Channel, isViolation } from './channel.ts';
import { APPLICATION_NAME } from './codes.ts';
import type { FailureCode } from './codes.ts';
import { executorTimeout, refusedCodeFor } from './closure.ts';
import { DeadlineExceeded } from './deadline.ts';
import { PRIVATE_FRAME_CAP } from './frame.ts';
import { PhysicalAuthError, PhysicalMismatchError, sqlStateOf, verifyPhysicalEndpoint } from './physical.ts';
import type { PhysicalDeps } from './physical.ts';
import type { QueryClient } from './physical.ts';
import { CHILD_HELLO_V1, decodeOwnerExecRequest, OWNER_EXEC_RESULT_V1 } from './private-frames.ts';
import type { OwnerExecRequest, OwnerExecResult } from './private-frames.ts';
import { readSecretFile, SecretFileError } from './secret-file.ts';

/**
 * The short-lived owner executor E (brief §6): one PAUSE_EXPORT, one owner connection, one transaction, one result frame.
 * The owner credential exists only here (read after the verified request, used for one connect). Every policy value stays
 * in SQL: E sees only fingerprints, states, versions and fences. The accepted owner routine is ALWAYS called (an already
 * PAUSED row is its accepted no-op); the postcondition is bound to the PRE-CALL state; REFUSED only for a ROLLBACK issued
 * before COMMIT was sent; anything uncertain after COMMIT was sent is COMMIT_UNKNOWN. A closure never follows ROLLBACK.
 */
export const EXEC_EXIT = Object.freeze({ OK: 0, DEADLINE: 20, PARENT_LOST: 21, PROTOCOL: 22 });
/** Brief §6: E's connect timeout is `min(300, DE − now)` (fixed; not widened by the physical-binding budget). */
export const E_CONNECT_TIMEOUT_MS = 300;
/** The production E connector (scripts/reval-server/owner-exec.ts): the unix-socket physical binding as the owner role. */
export function productionExecConnect(physical: PhysicalDeps): ExecDeps['connect'] {
  return async (request, password, connectTimeoutMs, budgetMs) => (await verifyPhysicalEndpoint({ endpoint: request.endpoint, physical: request.physical,
    role: request.ownerRole, applicationName: APPLICATION_NAME.owner, budgetMs, connectTimeoutMs }, password, physical)).client;
}

const FINGERPRINT = `SELECT p.state, p."stateReason" AS reason, p."policyVersion"::text AS version, f.version::text AS fence,
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(p)::text, 'UTF8')), 'hex') AS full,
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.to_jsonb(p) - ARRAY['policyVersion','state','stateReason','revisedAt'])::text, 'UTF8')), 'hex') AS rest
  FROM public."RemoteAskPolicy" p JOIN public."ActionAuthorityFence" f ON f."workspaceId" = p."workspaceId" WHERE p."workspaceId" = $1`;
export const REVISE_SQL = `SELECT public.atlas_ask_remote_policy_revise(p."workspaceId", p."admissionId", p."policyVersion", 'PAUSED', p."secretRef",
  p."ownerApprovalRef", p."retentionAttestationRef", p."priceRevision", p."promptSha256", p."schemaSha256", p."packageSha256", p."dayCapMicroUsd",
  p."monthCapMicroUsd", p."expiresAt")::text AS v FROM public."RemoteAskPolicy" p
  WHERE p."workspaceId" = $1 AND p."admissionId" = $2::uuid AND p."policyVersion" = $3::bigint`;
const CLEAR_SCOPE = `SELECT pg_catalog.set_config('app.workspace_id', '', true), pg_catalog.set_config('app.client_ids', '', true),
  pg_catalog.set_config('app.actor_id', '', true), pg_catalog.set_config('app.token_hash', '', true), pg_catalog.set_config('app.poweroffice_connection_id', '', true)`;

/** Test-only seams (passed as parameters by test harness entries; production passes none). */
export interface ExecHooks {
  readonly skipScope?: boolean;
  readonly reviseSql?: string;
  readonly beforeCommit?: (client: QueryClient) => Promise<void>;
  readonly commit?: (client: QueryClient) => Promise<void>;
}
export interface ExecDeps {
  readSecret(path: string): Promise<Buffer>;
  /**
   * Physical verification + connect (production: productionExecConnect → verifyPhysicalEndpoint over the unix socket only).
   * `connectTimeoutMs` is brief §6's fixed E connect timeout `min(300, DE − now)`; `budgetMs` bounds the whole binding (steps
   * 1–6) by E's own deadline. The connect step never gets more than `connectTimeoutMs`.
   */
  connect(request: OwnerExecRequest, password: string, connectTimeoutMs: number, budgetMs: number): Promise<QueryClient>;
  now(): number;
  readonly hooks?: ExecHooks;
}
const refused = (challenge: string, code: FailureCode): OwnerExecResult =>
  ({ contractVersion: OWNER_EXEC_RESULT_V1, challenge, outcome: 'REFUSED', revisionApplied: null, policyVersion: null, fenceEpoch: null, code });
const unknown = (challenge: string): OwnerExecResult =>
  ({ contractVersion: OWNER_EXEC_RESULT_V1, challenge, outcome: 'COMMIT_UNKNOWN', revisionApplied: null, policyVersion: null, fenceEpoch: null, code: null });
class Refuse extends Error { readonly code: FailureCode; constructor(code: FailureCode) { super(code); this.code = code; } }

/** One owner transaction for `request`, bounded by `deadline` (absolute on deps.now()). Never throws. */
export async function runOwnerExec(request: OwnerExecRequest, deadline: number, deps: ExecDeps): Promise<OwnerExecResult> {
  const c = request.challenge; const hooks = deps.hooks ?? {};
  let secret: Buffer;
  try { secret = await deps.readSecret(request.ownerSecretFile); } catch (e) { return refused(c, e instanceof SecretFileError ? 'UNAUTHORIZED' : 'INTERNAL_FAILURE'); }
  let client: QueryClient;
  const remaining = Math.max(1, Math.floor(deadline - deps.now()));
  try { client = await deps.connect(request, secret.toString('latin1'), Math.min(E_CONNECT_TIMEOUT_MS, remaining), remaining); }
  catch (e) {
    // §6: a credential/role refusal (28P01/28000/42501, SQLSTATE only) → OWNER_REQUIRED; a physical mismatch → REGISTRATION_MISMATCH;
    // the connect budget ran out → DEADLINE. No lock, no call, nothing to latch.
    return refused(c, e instanceof PhysicalAuthError ? refusedCodeFor(e.sqlState) : e instanceof PhysicalMismatchError ? 'REGISTRATION_MISMATCH'
      : e instanceof DeadlineExceeded ? 'DEADLINE' : refusedCodeFor(sqlStateOf(e)));
  }
  finally { secret.fill(0); }
  let commitSent = false;
  try {
    const t = executorTimeout(deadline, deps.now());
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(`SET LOCAL lock_timeout = ${t}`); await client.query(`SET LOCAL statement_timeout = ${t}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${t}`);
    await client.query(CLEAR_SCOPE);
    if (!hooks.skipScope) await client.query(`SELECT pg_catalog.set_config('app.workspace_id', $1, true)`, [request.workspaceId]);
    const reg = await client.query(`SELECT 1 FROM public."RevalSandboxRegistration" r WHERE r."registrationId" = $1::uuid AND r."databaseInstanceId" = $2::uuid
      AND r."workspaceId" = $3 AND r."clientId" = $4 AND r."actorId" = $5 AND r."admissionId" = $6::uuid`,
      [request.registrationId, request.databaseInstanceId, request.workspaceId, request.clientId, request.actorId, request.admissionId]);
    if (reg.rows.length !== 1) throw new Refuse('REGISTRATION_MISMATCH');
    const fence = await client.query(`SELECT f.version::text AS v FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = $1 FOR UPDATE`, [request.workspaceId]);
    if (fence.rows.length !== 1) throw new Refuse('REGISTRATION_MISMATCH');
    const pol = await client.query(`SELECT p."admissionId"::text AS a, p."policyVersion"::text AS v, p.state FROM public."RemoteAskPolicy" p
      WHERE p."workspaceId" = $1 FOR UPDATE`, [request.workspaceId]);
    if (pol.rows.length !== 1 || pol.rows[0]!.a !== request.admissionId) throw new Refuse('REGISTRATION_MISMATCH');
    if (pol.rows[0]!.v !== request.expectedPolicyVersion) throw new Refuse('POLICY_CHANGED');
    const state = pol.rows[0]!.state as string;
    if (state === 'REVOKED' || state === 'TOMBSTONE') throw new Refuse('CONTAINMENT_UNCONFIRMED');
    if (!['PAUSED', 'ACTIVE', 'INACTIVE'].includes(state)) throw new Refuse('INTERNAL_FAILURE');
    const pre = (await client.query(FINGERPRINT, [request.workspaceId])).rows[0]!;
    const call = await client.query(hooks.reviseSql ?? REVISE_SQL, [request.workspaceId, request.admissionId, request.expectedPolicyVersion]);
    const expected = BigInt(request.expectedPolicyVersion);
    const wanted = state === 'PAUSED' ? expected : expected + 1n;
    if (call.rows.length !== 1 || call.rows[0]!.v !== String(wanted)) throw new Refuse('POLICY_CHANGED');
    const post = (await client.query(FINGERPRINT, [request.workspaceId])).rows[0]!;
    const noop = post.full === pre.full && post.version === pre.version && post.fence === pre.fence;
    const applied = post.rest === pre.rest && post.version === String(expected + 1n) && post.state === 'PAUSED' && post.reason === 'OWNER'
      && BigInt(post.fence as string) === BigInt(pre.fence as string) + 1n;
    if (state === 'PAUSED' ? !noop : !applied) throw new Refuse('CONTAINMENT_UNCONFIRMED');
    if (hooks.beforeCommit) await hooks.beforeCommit(client);
    commitSent = true;
    if (hooks.commit) await hooks.commit(client); else {
      const done = await client.query('COMMIT') as unknown as { command?: string };
      if (done.command !== undefined && done.command !== 'COMMIT') return unknown(c);
    }
    return { contractVersion: OWNER_EXEC_RESULT_V1, challenge: c, outcome: 'CONFIRMED_COMMIT', revisionApplied: state !== 'PAUSED',
      policyVersion: post.version as string, fenceEpoch: post.fence as string, code: null };
  } catch (error) {
    if (commitSent) return unknown(c);
    await client.query('ROLLBACK').catch(() => undefined);
    return refused(c, error instanceof Refuse ? error.code : refusedCodeFor(sqlStateOf(error)));
  } finally {
    const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream;
    await client.end().catch(() => undefined);
    try { stream?.destroy(); } catch { /* gone */ }
  }
}

/**
 * The executor PROCESS (scripts/reval-server/owner-exec.ts and test entries): HELLO first on fd 3 with no credential and
 * no DB; then exactly one verified request; then runOwnerExec within its own monotonic timer; one result; exit. Parent EOF
 * or the deadline destroys everything immediately (exit, no graceful round trip).
 */
export async function runExecutorProcess(deps: Omit<ExecDeps, 'now'>, onFd3?: () => void): Promise<never> {
  const now = () => performance.now();
  let fd3ok = false;
  try { fd3ok = fstatSync(3).isSocket(); } catch { fd3ok = false; }
  if (!fd3ok) process.exit(EXEC_EXIT.PROTOCOL);
  onFd3?.();
  // Strict private channel (§2e): after HELLO exactly ONE request may arrive; a duplicate/coalesced/fragmented request or any
  // later frame exits at once inside the receiving `data` event (before the secret read/connect of the first one, or — when
  // it arrives later — abandoning the owner transaction; C then holds the commit-uncertain latch).
  const channel = new Channel(new Socket({ fd: 3, readable: true, writable: true }), PRIVATE_FRAME_CAP, { strict: true });
  const helloNonce = randomUUID();
  channel.onClose(e => { if (e.reason !== 'LOCAL') process.exit(isViolation(e.reason) ? EXEC_EXIT.PROTOCOL : EXEC_EXIT.PARENT_LOST); });
  channel.send({ contractVersion: CHILD_HELLO_V1, kind: 'EXECUTOR', helloNonce });
  let request: OwnerExecRequest;
  try {
    request = decodeOwnerExecRequest(await channel.next(1500));
    if (request.helloNonce !== helloNonce) throw new Error('nonce');
  } catch { process.exit(EXEC_EXIT.PROTOCOL); }
  const deadline = now() + request!.remainingMs - 50;
  setTimeout(() => process.exit(EXEC_EXIT.DEADLINE), Math.max(1, request!.remainingMs - 50)).unref();
  const result = await runOwnerExec(request!, deadline, { ...deps, now });
  await channel.sendAndFlush(result).catch(() => undefined);
  process.exit(EXEC_EXIT.OK);
}
export const OWNER_APPLICATION_NAME = APPLICATION_NAME.owner;
