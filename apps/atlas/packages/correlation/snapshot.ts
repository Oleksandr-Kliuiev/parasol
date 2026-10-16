import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermissions } from '../core/contracts.ts';
import { hasCurrentClientPermissions } from '../auth/authority.ts';
import { scopeContext } from '../graph/scope-context.ts';
import { withDenialAudit } from '../m365/denial.ts';
import { TENANT_GUID } from '../../connectors/microsoft365/contract.ts';
import { DB_CLOCK_SQL } from './time.ts';
import type { DbClock, TimeKey } from './time.ts';

/**
 * Read transaction of every Stage 2 stored-data read (02 §4, brief RC3 "Read transaction and current authority"):
 *  1. the authenticated Actor snapshot must hold every permission (all-of, one membership) — otherwise a denial;
 *  2. ONE Prisma RepeatableRead transaction whose first statement is the parameterized SET LOCAL of exactly one
 *     actor-derived client (as withScope); then, inside the same snapshot, the actor's CURRENT status/membership must still
 *     hold every permission (a revoke committed before this request started is therefore always seen); then the database
 *     clock, read once, is the clock of every eligibility/expiry/freshness decision of the read.
 * A permission or scope refusal at any of these points is recorded exactly once in the workspace SecurityAuditEvent
 * (requested client as text, fixed event type, empty metadata) and rethrown — never a client audit row. No credential
 * resolution, token request or upstream I/O happens in a read.
 */
export const READ_PERMISSIONS = Object.freeze(['context:read', 'm365:read'] as const);
export const STATUS_PERMISSIONS = Object.freeze(['connections:manage'] as const);
const READ_TIMEOUT_MS = 20_000;

export interface ReadAuthority { actor: Actor; scope: Scope; permissions: readonly string[]; deniedEvent: string }

/** Authentication-time all-of check plus one workspace denial for the whole public read operation. */
export function guardedRead<T>(db: PrismaClient, auth: ReadAuthority, operation: () => Promise<T>): Promise<T> {
  return withDenialAudit(db, auth.actor, auth.scope, auth.deniedEvent, async () => {
    assertPermissions(auth.actor, auth.scope, auth.permissions);
    return operation();
  });
}

export async function withReadSnapshot<T>(db: PrismaClient, auth: ReadAuthority,
  fn: (tx: Prisma.TransactionClient, clock: DbClock) => Promise<T>): Promise<T> {
  const ctx = scopeContext(auth.actor, [auth.scope.clientId]);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.client_ids', ${ctx.clientIds}, true)`;
    if (!await hasCurrentClientPermissions(tx, auth.actor, auth.scope.clientId, auth.permissions)) throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
    const [clock] = await tx.$queryRaw<{ nowMs: Date; nowKey: TimeKey }[]>(DB_CLOCK_SQL);
    return fn(tx, Object.freeze({ now: clock!.nowMs, key: clock!.nowKey }));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: READ_TIMEOUT_MS, maxWait: 10_000 });
}

export interface M365ConnectionState { id: string; system: string; status: string; lifecycleVersion: number; bound: boolean }
/** The selected M365 connection inside the snapshot (no lock; nothing is published by a read). */
export async function readSelectedConnection(tx: Prisma.TransactionClient, scope: Scope, connectionId: string): Promise<M365ConnectionState> {
  const row = await tx.connection.findUnique({ where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: connectionId } },
    select: { id: true, system: true, status: true, lifecycleVersion: true, boundBy: true, externalTenantId: true } });
  if (!row) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  if (row.system !== 'microsoft365') throw new AtlasError('CONNECTION_NOT_M365', 'VALIDATION');
  if (row.status === 'FIXTURE') throw new AtlasError('FIXTURE_CONNECTION_NOT_SUPPORTED', 'VALIDATION');
  if (!row.boundBy || !TENANT_GUID.test(row.externalTenantId)) throw new AtlasError('BINDING_PROVENANCE_MISSING', 'VALIDATION');
  if (row.status !== 'ACTIVE' && row.status !== 'DISABLED') throw new AtlasError('CONNECTION_STATUS_UNSUPPORTED', 'VALIDATION');
  return { id: row.id, system: row.system, status: row.status, lifecycleVersion: Number(row.lifecycleVersion), bound: true };
}
/** Ordinary identity/evidence reads need the selected connection ACTIVE: they fail after disable ("revoke"). */
export function assertReadable(connection: M365ConnectionState): void {
  if (connection.status !== 'ACTIVE') throw new AtlasError('CONNECTION_NOT_LIVE', 'VALIDATION');
}
