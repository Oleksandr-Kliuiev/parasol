import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { AtlasError, hasClientPermissions } from '../core/contracts.ts';
import { BEARER_TOKEN_PATTERN, hashToken } from '../auth/token.ts';
import { currentToken, setLocal } from '../auth/transaction-token.ts';
import { auditText, sanitizeAuditMetadata } from '../audit/sanitize.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../graph/fence-role.ts';
import type { ActionFenceFacts } from '../graph/fence-role.ts';
import { POWEROFFICE_READY_SQL, powerOfficeProblems } from '../graph/poweroffice-role.ts';
import type { PowerOfficeFacts } from '../graph/poweroffice-role.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { isDbConflict, isFenceNotReady, sqlState } from '../graph/fence-errors.ts';
import { POWEROFFICE_PERMISSIONS, isPowerOfficeErrorCode, powerOfficeError } from './contracts.ts';
import type { PowerOfficeErrorCode, PowerOfficeOperation } from './contracts.ts';
import { readConnection } from './binding.ts';
import type { ConnectionRow } from './binding.ts';

/**
 * Private bearer-based PowerOffice transaction authority (docs/stage4/02_CONTRACTS.md "Authentication and permissions",
 * 03 "Protected reads and lock order"). The foundation every S4-B/S4-C service runs through; it is not an entry point.
 * One READ COMMITTED transaction as the confined runtime role:
 *   1. accepted bearer-hash lookup (shared verbatim with Stage 3, packages/auth/transaction-token.ts) → workspace hint;
 *   2. the workspace authority fence row FOR SHARE (read) or FOR UPDATE (sync/recover/maintain) — always the first lock —
 *      then the Stage 3 fence and the Stage 4 PowerOffice readiness facts (fail closed: POWEROFFICE_RUNTIME_NOT_READY);
 *   3. re-authentication behind the fence (current token row, same workspace), the ACTIVE actor, and ALL permissions of the
 *      operation on ONE membership of the chosen client; otherwise exactly one workspace SecurityAuditEvent (requested
 *      client as escaped text, never a client audit row) and a fixed refusal; a failed denial audit is AUDIT_FAILED/DB_CONFLICT;
 *   4. only then the client scope (proper scope before any data) and a plain scoped Connection read (no row lock);
 *   5. the operation's own row locks (`lock`: State/Attempt, see locks.ts);
 *   6. AFTER ALL LOCKS: the DB clock and the current token again (revocation and exact expiry after any lock wait), the
 *      ACTIVE actor and all-of permissions again; an expired or changed caller refuses with zero effects and no audit;
 *   7. `run` decides under that clock. A refusal it returns commits whatever `run` wrote (its audit) and then throws.
 * Every setting is transaction-local; the token digest is cleared before anything else runs. No Actor, permission, token
 * row or clock is taken from the caller. New permissions are never assigned automatically. No automatic retry.
 */
export interface PowerOfficeCredential { readonly kind: 'PowerOfficeCredential' }
const bearerHashes = new WeakMap<PowerOfficeCredential, string>();
/** Opaque private credential: only the SHA-256 digest of the bearer is kept, in memory; malformed input never reaches SQL. */
export function powerOfficeCredential(bearer: unknown): PowerOfficeCredential {
  if (typeof bearer !== 'string' || !BEARER_TOKEN_PATTERN.test(bearer)) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
  const credential: PowerOfficeCredential = Object.freeze({ kind: 'PowerOfficeCredential' as const });
  bearerHashes.set(credential, hashToken(bearer));
  return credential;
}

export interface PowerOfficeRequest { clientId: string; connectionId: string; operation: PowerOfficeOperation }
/** The admitted scope handed to `lock`: settings already confine the transaction to this workspace/client. */
export interface PowerOfficeScope {
  readonly workspaceId: string; readonly clientId: string; readonly connectionId: string; readonly actorId: string;
  readonly operation: PowerOfficeOperation; readonly correlationId: string; readonly epoch: number;
}
/** What `run` decides with: the scope, the plain binding read and the DB clock read after the last lock. */
export interface PowerOfficeAuthority extends PowerOfficeScope { readonly now: Date; readonly connection: ConnectionRow | null }
export type PowerOfficeOutcome<T> = { ok: T } | { refused: PowerOfficeErrorCode };
export interface PowerOfficeSteps<L, T> {
  lock(tx: Prisma.TransactionClient, scope: PowerOfficeScope): Promise<L>;
  run(tx: Prisma.TransactionClient, authority: PowerOfficeAuthority, locked: L): Promise<PowerOfficeOutcome<T>>;
}

const FENCE_SHARE = `SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`;
const FENCE_UPDATE = `SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`;

/**
 * S4-B: private marker of a POSITIVELY KNOWN rollback. Only an actual PostgreSQL deadlock/serialization abort (SQLSTATE
 * 40P01/40001) marks its fixed POWEROFFICE_DB_CONFLICT; a Prisma P2034/P2028, a timeout, an unknown commit outcome or any
 * other conflict stays unmarked. The mark is membership of the fixed error object in this module-private WeakSet — no
 * property, detail or raw error is attached, so the public error (code, kind, no details) is identical either way. Only
 * publication and the private failure continuation use it, for their bounded same-fact re-run.
 */
const knownRollbacks = new WeakSet<AtlasError>();
export const isKnownRollback = (error: unknown): boolean => error instanceof AtlasError && knownRollbacks.has(error);

/** Fixed public code of any failure: known PowerOffice codes pass, fence/conflict SQLSTATEs map, everything else is unexpected. */
export function powerOfficeFailure(error: unknown): AtlasError {
  if (error instanceof AtlasError && isPowerOfficeErrorCode(error.code)) return powerOfficeError(error.code);
  if (isFenceNotReady(error)) return powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
  // Fixed SQLSTATEs of the PowerOffice guards (migration 202610091210): the original claim deadline and the retention cap.
  if (sqlState(error) === 'PO007') return powerOfficeError('POWEROFFICE_DEADLINE');
  if (sqlState(error) === 'PO006') return powerOfficeError('POWEROFFICE_SYNC_LIMIT');
  if (isDbConflict(error) || (error as { code?: unknown } | null)?.code === 'P2028') {
    const fixed = powerOfficeError('POWEROFFICE_DB_CONFLICT');
    const state = sqlState(error);
    if (state === '40P01' || state === '40001') knownRollbacks.add(fixed);
    return fixed;
  }
  return powerOfficeError('UNEXPECTED_ERROR');
}
const auditFailure = (error: unknown): AtlasError => powerOfficeError(isDbConflict(error) ? 'POWEROFFICE_DB_CONFLICT' : 'POWEROFFICE_AUDIT_FAILED');

/** The actor of a current token, read through the confined Actor_self/ClientMembership_self policies (app.actor_id). */
async function currentActor(tx: Prisma.TransactionClient, workspaceId: string, actorId: string): Promise<Actor | null> {
  await setLocal(tx, { 'app.token_hash': '', 'app.workspace_id': workspaceId, 'app.client_ids': '', 'app.actor_id': actorId });
  const row = await tx.actor.findUnique({ where: { workspaceId_id: { workspaceId, id: actorId } },
    select: { id: true, status: true, workspacePermissions: true, memberships: { select: { clientId: true, permissions: true }, orderBy: { clientId: 'asc' } } } });
  await setLocal(tx, { 'app.actor_id': '' });
  if (!row || row.status !== 'ACTIVE') return null;
  return { id: row.id, workspaceId, workspacePermissions: [...row.workspacePermissions],
    memberships: row.memberships.map(m => ({ clientId: m.clientId, permissions: [...m.permissions] })) };
}
const holds = (actor: Actor, clientId: string, operation: PowerOfficeOperation) =>
  SCOPE_ID_PATTERN.test(clientId) && hasClientPermissions(actor, clientId, POWEROFFICE_PERMISSIONS[operation]);

export async function withPowerOfficeAuthority<L, T>(db: PrismaClient, credential: PowerOfficeCredential, request: PowerOfficeRequest,
  steps: PowerOfficeSteps<L, T>): Promise<T> {
  const hash = bearerHashes.get(credential);
  if (hash === undefined || !Object.hasOwn(POWEROFFICE_PERMISSIONS, request.operation)) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
  const { clientId, connectionId, operation } = request;
  let outcome: PowerOfficeOutcome<T>;
  try {
    outcome = await db.$transaction(async tx => {
      await setLocal(tx, { 'app.token_hash': '', 'app.workspace_id': '', 'app.client_ids': '', 'app.actor_id': '', 'app.poweroffice_connection_id': '' });
      const hint = await currentToken(tx, hash);
      if (!hint) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
      const workspaceId = hint.workspaceId;
      await setLocal(tx, { 'app.workspace_id': workspaceId });
      // A missing lock privilege (UPDATE(workspaceId)) is an unready surface, not an unexpected error.
      const fence = await tx.$queryRawUnsafe<{ version: number }[]>(operation === 'read' ? FENCE_SHARE : FENCE_UPDATE, workspaceId)
        .catch((error: unknown) => { throw sqlState(error) === '42501' ? powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY') : error; });
      if (fence.length !== 1) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
      const actionFacts = await tx.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL);
      const poFacts = await tx.$queryRawUnsafe<PowerOfficeFacts[]>(POWEROFFICE_READY_SQL);
      if (actionFenceProblems(actionFacts[0]).length > 0 || powerOfficeProblems(poFacts[0]).length > 0) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
      const token = await currentToken(tx, hash);
      if (!token || token.workspaceId !== workspaceId) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
      const actor = await currentActor(tx, workspaceId, token.actorId);
      if (!actor) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
      const correlationId = randomUUID();
      if (!holds(actor, clientId, operation)) {
        const member = SCOPE_ID_PATTERN.test(clientId) && actor.memberships.some(m => m.clientId === clientId);
        const code: PowerOfficeErrorCode = member ? 'PERMISSION_DENIED' : 'SCOPE_DENIED';
        try {
          await setLocal(tx, { 'app.workspace_id': workspaceId, 'app.client_ids': '' });
          await tx.securityAuditEvent.create({ data: { workspaceId, id: randomUUID(), actorId: actor.id, eventType: `poweroffice.${operation}.denied`,
            outcome: 'DENIED', requestedClientId: auditText(clientId), reasonCode: code, correlationId, metadata: sanitizeAuditMetadata({}) }, select: { id: true } });
        } catch (error) { throw auditFailure(error); }
        return { refused: code };
      }
      await setLocal(tx, { 'app.workspace_id': workspaceId, 'app.client_ids': clientId });
      const scope: PowerOfficeScope = Object.freeze({ workspaceId, clientId, connectionId, actorId: actor.id, operation, correlationId,
        epoch: Number(fence[0]!.version) });
      const connection = SCOPE_ID_PATTERN.test(connectionId) ? await readConnection(tx, workspaceId, clientId, connectionId) : null;
      const locked = await steps.lock(tx, scope);
      // After ALL locks: DB clock, current token (revocation/expiry), ACTIVE actor and all-of rights again.
      const last = await currentToken(tx, hash);
      const again = last && last.workspaceId === workspaceId && last.actorId === actor.id ? await currentActor(tx, workspaceId, last.actorId) : null;
      if (!last || !again || !holds(again, clientId, operation)) throw powerOfficeError('POWEROFFICE_AUTHENTICATION_FAILED');
      await setLocal(tx, { 'app.token_hash': '', 'app.actor_id': '', 'app.workspace_id': workspaceId, 'app.client_ids': clientId });
      return steps.run(tx, Object.freeze({ ...scope, now: last.now, connection }), locked);
    }, { maxWait: 10_000, timeout: 20_000 });
  } catch (error) { throw powerOfficeFailure(error); }
  if ('refused' in outcome) throw powerOfficeError(outcome.refused);
  return outcome.ok;
}
