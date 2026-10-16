import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission } from '../core/contracts.ts';
import type { SecretResolver } from '../../connectors/contracts.ts';
import type { M365Authority } from '../../connectors/microsoft365/connector.ts';
import { TENANT_GUID } from '../../connectors/microsoft365/contract.ts';
import { issueM365Connection } from '../connections/connections.ts';
import { hasCurrentClientPermissions } from '../auth/authority.ts';
import { withScope } from '../graph/scoped-db.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';

/**
 * Connection authority of the M365 services (docs/stage2/02_CONTRACTS.md §1, 03 §2). Ordinary sync needs
 * system=microsoft365, ACTIVE, recorded binding provenance and the actor's CURRENT events:ingest + connections:manage;
 * activation probes need a bound DISABLED connection and connections:manage, through an issued capability only.
 * Every claim/publication takes the Connection first (FOR SHARE — the fence m365-disable and cleanup take FOR NO KEY
 * UPDATE), then checks it and the actor's authority under that lock with the clock read afterwards. A pin fixes tenant and
 * lifecycleVersion at claim; any later difference (disable, reactivation, rebinding) is M365_CONNECTION_CHANGED.
 */
export type M365Purpose = 'sync' | 'activation';
export const M365_PERMISSIONS: Readonly<Record<M365Purpose, readonly string[]>> = Object.freeze({
  sync: ['events:ingest', 'connections:manage'], activation: ['connections:manage'],
});
export interface M365ConnectionRow { system: string; status: string; externalTenantId: string; secretRef: string; lifecycleVersion: number; boundBy: string | null }
export interface M365Pin extends Scope { connectionId: string; tenantId: string; lifecycleVersion: number; purpose: M365Purpose }

export function assertM365Permissions(actor: Actor, scope: Scope, purpose: M365Purpose, connectionId: string): void {
  for (const permission of M365_PERMISSIONS[purpose]) assertPermission(actor, scope, permission);
  if (!SCOPE_ID_PATTERN.test(connectionId)) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
}

/** The Connection row, locked FOR SHARE (claims, publication) or read without a lock (per-call recheck). */
export async function readM365Connection(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, lock: boolean): Promise<M365ConnectionRow> {
  const rows = lock
    ? await tx.$queryRaw<M365ConnectionRow[]>`SELECT system, status, "externalTenantId", "secretRef", "lifecycleVersion", "boundBy" FROM "Connection"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${connectionId} FOR SHARE`
    : await tx.$queryRaw<M365ConnectionRow[]>`SELECT system, status, "externalTenantId", "secretRef", "lifecycleVersion", "boundBy" FROM "Connection"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${connectionId}`;
  const row = rows[0];
  if (!row) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  return { ...row, lifecycleVersion: Number(row.lifecycleVersion) };
}

/** Status/binding rules of a purpose; with a pin also unchanged tenant and lifecycleVersion. */
export function assertM365Connection(row: M365ConnectionRow, purpose: M365Purpose, pin?: Pick<M365Pin, 'tenantId' | 'lifecycleVersion'>): void {
  if (row.system !== 'microsoft365') throw new AtlasError('CONNECTION_NOT_M365', 'VALIDATION');
  if (row.status === 'FIXTURE') throw new AtlasError('FIXTURE_CONNECTION_NOT_SUPPORTED', 'VALIDATION');
  if (!row.boundBy || !TENANT_GUID.test(row.externalTenantId)) throw new AtlasError('BINDING_PROVENANCE_MISSING', 'VALIDATION');
  if (pin && (row.lifecycleVersion !== pin.lifecycleVersion || row.externalTenantId !== pin.tenantId)) throw new AtlasError('M365_CONNECTION_CHANGED', 'PERMANENT');
  if (purpose === 'sync' && row.status !== 'ACTIVE') throw new AtlasError(pin ? 'M365_CONNECTION_CHANGED' : 'CONNECTION_NOT_LIVE', pin ? 'PERMANENT' : 'VALIDATION');
  if (purpose === 'activation' && row.status !== 'DISABLED') {
    throw new AtlasError(pin ? 'M365_CONNECTION_CHANGED' : row.status === 'ACTIVE' ? 'CONNECTION_ALREADY_ACTIVE' : 'CONNECTION_STATUS_UNSUPPORTED', pin ? 'PERMANENT' : 'VALIDATION');
  }
}

/** The actor's CURRENT membership (not the authenticated snapshot) must still hold every permission of the purpose. */
export async function assertCurrentAuthority(tx: Prisma.TransactionClient, actor: Actor, clientId: string, purpose: M365Purpose): Promise<void> {
  if (!await hasCurrentClientPermissions(tx, actor, clientId, M365_PERMISSIONS[purpose])) throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
}

/** Connection FOR SHARE, purpose rules (and pin), current authority — the common head of every claim and publication. */
export async function lockAndCheck(tx: Prisma.TransactionClient, actor: Actor, pin: M365Pin): Promise<M365ConnectionRow>;
export async function lockAndCheck(tx: Prisma.TransactionClient, actor: Actor, scope: Scope, connectionId: string, purpose: M365Purpose): Promise<M365ConnectionRow>;
export async function lockAndCheck(tx: Prisma.TransactionClient, actor: Actor, scopeOrPin: Scope | M365Pin, connectionId?: string, purpose?: M365Purpose): Promise<M365ConnectionRow> {
  const pin = connectionId === undefined ? scopeOrPin as M365Pin : undefined;
  const id = pin?.connectionId ?? connectionId!;
  const use = pin?.purpose ?? purpose!;
  const row = await readM365Connection(tx, scopeOrPin, id, true);
  assertM365Connection(row, use, pin);
  await assertCurrentAuthority(tx, actor, scopeOrPin.clientId, use);
  return row;
}

/**
 * Head of a failure/requeue transaction: the Connection is still taken first (lock order) but need not be ACTIVE — a failed
 * attempt of a connection disabled meanwhile is still recorded as failed — and the actor's current authority is required.
 */
export async function lockForRecording(tx: Prisma.TransactionClient, actor: Actor, scope: Scope, connectionId: string): Promise<M365ConnectionRow> {
  const row = await readM365Connection(tx, scope, connectionId, true);
  if (row.system !== 'microsoft365') throw new AtlasError('CONNECTION_NOT_M365', 'VALIDATION');
  await assertCurrentAuthority(tx, actor, scope.clientId, 'sync');
  return row;
}

export const pinOf = (scope: Scope, connectionId: string, row: M365ConnectionRow, purpose: M365Purpose): M365Pin =>
  Object.freeze({ workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId, tenantId: row.externalTenantId, lifecycleVersion: row.lifecycleVersion, purpose });

/**
 * The authority a Graph session rechecks before each secret resolution and each vendor call: the pinned connection
 * unchanged and the actor's current authority, plus `claimCheck` (the caller's claim still current: generation STAGING with
 * its token, attempt RUNNING before lease/deadline, capability unexpired). One short scoped transaction, no lock held
 * over the network.
 */
export function graphAuthority(db: PrismaClient, actor: Actor, pin: M365Pin, secrets: SecretResolver,
  claimCheck?: (tx: Prisma.TransactionClient) => Promise<void>): M365Authority {
  const scope: Scope = { workspaceId: pin.workspaceId, clientId: pin.clientId };
  return Object.freeze({
    workspaceId: pin.workspaceId, clientId: pin.clientId, connectionId: pin.connectionId, tenantId: pin.tenantId, lifecycleVersion: pin.lifecycleVersion,
    recheck: () => withScope(db, actor, [pin.clientId], async tx => {
      const row = await readM365Connection(tx, scope, pin.connectionId, false);
      assertM365Connection(row, pin.purpose, pin);
      await assertCurrentAuthority(tx, actor, pin.clientId, pin.purpose);
      await claimCheck?.(tx);
      return { secretRef: row.secretRef };
    }),
    resolveSecret: (secretRef: string) => secrets.resolve(secretRef,
      issueM365Connection(scope, { id: pin.connectionId, system: 'microsoft365', externalTenantId: pin.tenantId })),
  });
}
