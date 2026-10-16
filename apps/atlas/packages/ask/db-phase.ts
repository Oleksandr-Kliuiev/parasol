import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hasClientPermissions } from '../core/contracts.ts';
import type { Actor } from '../core/contracts.ts';
import { currentToken, setLocal } from '../auth/transaction-token.ts';
import { auditText, sanitizeAuditMetadata } from '../audit/sanitize.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../graph/fence-role.ts';
import type { ActionFenceFacts } from '../graph/fence-role.ts';
import { isFenceNotReady, sqlState } from '../graph/fence-errors.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { ASK_AUDIT, ASK_LIMITS, AskFailure, askFailure, isAskFailure } from './contracts.ts';
import type { AskErrorCode } from './contracts.ts';
import { credentialDigest } from './credential.ts';
import type { AskCredential } from './credential.ts';
import { AskPhase, phaseSql } from './phase.ts';
import type { PhaseRun, PhaseSql } from './phase.ts';
import { AskStopped } from './service.ts';
import type { AskIdentity, AskRun } from './service.ts';

/**
 * Shared bounded DB phase and fenced current authority of the DB Ask ports (extracted unchanged from authority.ts so the
 * ASK-REMOTE port reuses the SAME guards; docs/stage5/ask/03 "Current bearer and client authority", remote 04).
 *
 * phaseTx: ONE transaction with ONE absolute end fixed at its start (`ms`): pool maxWait ≤min(500 ms, phase), transaction
 * timeout = phase, and every statement through phaseSql (checks + remaining-phase statement_timeout). The caller sees the
 * phase end at its absolute deadline even while a statement or the driver is still busy; that race NEVER releases capacity:
 * `hold` keeps the transaction promise AND its callback until both actually settle. A stopped phase starts no statement.
 * `failure` maps a non-stop error to the fixed caller error; `committed` is true once the body has returned (COMMIT sent).
 */
export const TIMEOUT_CODES: ReadonlySet<string> = new Set(['P2024', 'P2028']);
export type Phase = 'authenticate' | 'admit' | 'publish';

/** Fixed code of a phase failure: decided codes pass, fence/privilege → not ready, timeouts → deadline, else per phase. */
export function phaseFailure(phase: Phase, error: unknown, committed: boolean): AskErrorCode {
  if (isAskFailure(error)) return error.code;
  if (isFenceNotReady(error) || sqlState(error) === '42501') return 'ASK_RUNTIME_NOT_READY';
  const code = (error as { code?: unknown } | null)?.code;
  if (!committed && ((typeof code === 'string' && TIMEOUT_CODES.has(code)) || sqlState(error) === '57014')) return 'ASK_DEADLINE';
  return phase === 'publish' ? 'ASK_AUDIT_FAILED' : 'ASK_RUNTIME_NOT_READY';
}

const settled = () => undefined;
export async function phaseTx<T>(db: PrismaClient, run: PhaseRun, ms: number, hold: (work: Promise<unknown>) => void,
  fn: (sql: PhaseSql) => Promise<T>, failure: (error: unknown, committed: boolean) => Error): Promise<T> {
  const phase = new AskPhase(run, ms);
  let body: Promise<T> | undefined;
  let bodyDone = false;
  const outer = db.$transaction(tx => {
    body = (async () => {
      const value = await fn(phaseSql(tx, phase));
      bodyDone = true;
      return value;
    })();
    return body;
  }, { maxWait: Math.min(ASK_LIMITS.poolWaitMs, ms), timeout: ms });
  hold(outer.then(settled, settled).then(() => body?.then(settled, settled)));
  outer.catch(() => phase.stop());
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { phase.stop(); reject(new AskFailure('ASK_DEADLINE')); }, ms);
  });
  try { return await Promise.race([outer, expiry]); } catch (error) {
    phase.stop();
    if (error instanceof AskStopped) throw error;
    throw failure(error, bodyDone);
  } finally { clearTimeout(timer); }
}

/** One bounded phase of the request: min(2 s, remaining original budget), held by the request's owner. */
export async function boundedTx<T>(db: PrismaClient, run: AskRun, phaseName: Phase, fn: (sql: PhaseSql) => Promise<T>): Promise<T> {
  run.check();
  const ms = run.deadline.phase(ASK_LIMITS.phaseMs);
  if (ms < 1) askFailure('ASK_DEADLINE');
  return phaseTx(db, run, ms, work => run.owner.hold(work), fn, (error, committed) => new AskFailure(phaseFailure(phaseName, error, committed)));
}

export const digestOf = (credential: AskCredential): string => credentialDigest(credential) ?? askFailure('ASK_AUTHENTICATION_FAILED');
export const clearSettings = (sql: PhaseSql) =>
  sql(tx => setLocal(tx, { 'app.token_hash': '', 'app.workspace_id': '', 'app.client_ids': '', 'app.actor_id': '' }));

/** Actor of a current token through the confined Actor_self/ClientMembership_self policies; ACTIVE only. */
export async function currentActor(sql: PhaseSql, workspaceId: string, actorId: string, memberships: boolean): Promise<Actor | null> {
  await sql(tx => setLocal(tx, { 'app.token_hash': '', 'app.workspace_id': workspaceId, 'app.client_ids': '', 'app.actor_id': actorId }));
  const row = await sql(tx => tx.actor.findUnique({ where: { workspaceId_id: { workspaceId, id: actorId } },
    select: { id: true, status: true, ...(memberships ? { memberships: { select: { clientId: true, permissions: true }, orderBy: { clientId: 'asc' } } } : {}) } }));
  await sql(tx => setLocal(tx, { 'app.actor_id': '' }));
  if (!row || row.status !== 'ACTIVE') return null;
  const rows = (row as { memberships?: { clientId: string; permissions: string[] }[] }).memberships ?? [];
  return { id: row.id, workspaceId, workspacePermissions: [], memberships: rows.map(m => ({ clientId: m.clientId, permissions: [...m.permissions] })) };
}

/** The current token still names exactly the captured identity (DB clock, after every lock and INSERT wait). */
export async function stillCurrent(sql: PhaseSql, hash: string, identity: AskIdentity): Promise<boolean> {
  const token = await sql(tx => currentToken(tx, hash));
  return token !== null && token.workspaceId === identity.workspaceId && token.actorId === identity.actorId;
}

const FENCE_SHARE = `SELECT version::text AS version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`;
export type Authority = { readonly refused: 'ASK_SCOPE_DENIED' } | { readonly epoch: string; readonly now: Date };
/**
 * Settings cleared → current-token hint → app.workspace_id = hint BEFORE the FIRST lock: ActionAuthorityFence FOR SHARE →
 * fence readiness → after the lock: current token with the DB clock, SAME workspace AND actor as private authentication,
 * ACTIVE actor, ONE membership of the path client holding EVERY listed permission (all-of; MOCK lists context:read only) →
 * else exactly one workspace `ask.scope_denied` (post-INSERT expiry/deadline checks). Fence version is the exact DB integer.
 */
export async function fencedAuthority(sql: PhaseSql, run: AskRun, identity: AskIdentity, hash: string, clientId: string,
  permissions: readonly string[] = [ASK_AUDIT.permission]): Promise<Authority> {
  await clearSettings(sql);
  const hint = await sql(tx => currentToken(tx, hash));
  if (!hint || hint.workspaceId !== identity.workspaceId || hint.actorId !== identity.actorId) askFailure('ASK_AUTHENTICATION_FAILED');
  await sql(tx => setLocal(tx, { 'app.workspace_id': identity.workspaceId }));
  const fence = await sql(tx => tx.$queryRawUnsafe<{ version: string }[]>(FENCE_SHARE, identity.workspaceId));
  if (fence.length !== 1 || typeof fence[0]!.version !== 'string') askFailure('ASK_RUNTIME_NOT_READY');
  const facts = await sql(tx => tx.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL));
  if (actionFenceProblems(facts[0]).length > 0) askFailure('ASK_RUNTIME_NOT_READY');
  const token = await sql(tx => currentToken(tx, hash));
  if (!token || token.workspaceId !== identity.workspaceId || token.actorId !== identity.actorId) askFailure('ASK_AUTHENTICATION_FAILED');
  const actor = await currentActor(sql, identity.workspaceId, identity.actorId, true) ?? askFailure('ASK_AUTHENTICATION_FAILED');
  const member = SCOPE_ID_PATTERN.test(clientId) && actor.memberships.some(m => m.clientId === clientId);
  if (member && hasClientPermissions(actor, clientId, permissions)) return { epoch: fence[0]!.version, now: token.now };
  // Exactly one workspace denial (requested client as escaped text, empty metadata), never a client audit row.
  await sql(tx => setLocal(tx, { 'app.workspace_id': identity.workspaceId, 'app.client_ids': '' }));
  try {
    await sql(tx => tx.securityAuditEvent.create({ data: { workspaceId: identity.workspaceId, id: randomUUID(), actorId: identity.actorId,
      eventType: ASK_AUDIT.denied, outcome: 'DENIED', requestedClientId: auditText(clientId), reasonCode: member ? 'PERMISSION_DENIED' : 'SCOPE_DENIED',
      correlationId: run.correlationId, metadata: sanitizeAuditMetadata({}) }, select: { id: true } }));
  } catch (error) { if (isAskFailure(error) || error instanceof AskStopped) throw error; askFailure('ASK_AUDIT_FAILED'); }
  if (!await stillCurrent(sql, hash, identity)) askFailure('ASK_AUTHENTICATION_FAILED');
  sql.check();
  return { refused: 'ASK_SCOPE_DENIED' };
}
