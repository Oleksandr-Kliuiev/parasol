import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope, System } from '../core/contracts.ts';
import { AtlasError, assertPermission, assertScope } from '../core/contracts.ts';
import type { ResolvedConnection, SecretResolver } from '../../connectors/contracts.ts';
import { withScope, uniqueViolation } from '../graph/scoped-db.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { clientAuditData } from '../audit/prisma.ts';

/**
 * ConnectionsModule core (task 1.4). A Connection is the explicit binding of one Atlas client to one external
 * customer/organization (externalTenantId) plus a secret reference. Adapters and secret resolvers receive a
 * ResolvedConnection that only this module issues — scoped lookup through the runtime role, enabled status, the bound
 * tenant read from the database. A tenant ID from a request body, an event or a model is never part of it.
 */

/** Systems with a Stage 1 connector. Microsoft 365 and PowerOffice are bound in their own slices. */
export const BINDABLE_SYSTEMS: readonly System[] = ['atera', 'huntress'];
/** Vendor customer/organization ID: printable, bounded, no separator that could widen an upstream filter. */
export const EXTERNAL_TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A stable secret name in a vault (env/fixture for local use). Never the credential: a value is rotated in the vault. */
export const SECRET_REF_PATTERN = /^(vault|env|fixture):\/\/[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const READABLE_STATUSES = new Set(['FIXTURE', 'ACTIVE']);

export type ConnectionPurpose = 'sync' | 'read';
const purposePermission: Record<ConnectionPurpose, string> = { sync: 'events:ingest', read: 'context:read' };

/** Issued connections and what they were issued for; only these objects pass assertResolvedConnection. */
const issued = new WeakMap<object, ConnectionPurpose | 'activation'>();
/** First call of every adapter and secret resolver: only a ResolvedConnection issued by this module passes. */
export function assertResolvedConnection(connection: ResolvedConnection): void {
  if (typeof connection !== 'object' || connection === null || !issued.has(connection)) throw new AtlasError('CONNECTION_NOT_RESOLVED', 'SCOPE');
}
function issue(scope: Scope, row: { id: string; system: string; externalTenantId: string }, purpose: ConnectionPurpose | 'activation'): ResolvedConnection {
  const resolved: ResolvedConnection = Object.freeze({ workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId: row.id,
    system: row.system as System, externalTenantId: row.externalTenantId });
  issued.set(resolved, purpose);
  return resolved;
}

/** Sync order step 1 (docs/03): check connection status and mapping, inside the actor's scope, then issue. */
export async function resolveConnection(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, purpose: ConnectionPurpose): Promise<ResolvedConnection> {
  assertPermission(actor, scope, purposePermission[purpose]);
  if (!SCOPE_ID_PATTERN.test(connectionId)) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  const row = await withScope(db, actor, [scope.clientId], tx => tx.connection.findUnique({
    where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: connectionId } },
    select: { id: true, system: true, externalTenantId: true, status: true } }));
  if (!row) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  if (!READABLE_STATUSES.has(row.status)) throw new AtlasError('CONNECTION_DISABLED', 'VALIDATION');
  return issue(scope, row, purpose);
}

/** For the activation health check only (connections:manage): a DISABLED connection with recorded binding provenance. */
export async function resolveConnectionForActivation(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string): Promise<ResolvedConnection> {
  assertPermission(actor, scope, 'connections:manage');
  if (!SCOPE_ID_PATTERN.test(connectionId)) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  const row = await withScope(db, actor, [scope.clientId], tx => tx.connection.findUnique({
    where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: connectionId } },
    select: { id: true, system: true, externalTenantId: true, status: true, boundBy: true } }));
  if (!row) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  if (row.status !== 'DISABLED') throw new AtlasError(row.status === 'ACTIVE' ? 'CONNECTION_ALREADY_ACTIVE' : 'FIXTURE_CONNECTION_HAS_NO_UPSTREAM', 'VALIDATION');
  if (!row.boundBy) throw new AtlasError('BINDING_PROVENANCE_MISSING', 'VALIDATION');
  return issue(scope, row, 'activation');
}

/**
 * Sync order step 2 (docs/03): the credential of an issued connection, read through the actor's scope and resolved in
 * memory. Only an ACTIVE connection — or a DISABLED one issued for its activation check — ever reaches a vendor; a
 * FIXTURE connection never does. The binding is re-read, so a connection changed since issue is refused.
 */
export async function resolveCredential(db: PrismaClient, actor: Actor, connection: ResolvedConnection, resolver: SecretResolver): Promise<string> {
  const purpose = issued.get(connection);
  if (!purpose) throw new AtlasError('CONNECTION_NOT_RESOLVED', 'SCOPE');
  const scope = { workspaceId: connection.workspaceId, clientId: connection.clientId };
  assertScope(actor, scope);
  const row = await withScope(db, actor, [scope.clientId], tx => tx.connection.findUnique({
    where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: connection.connectionId } },
    select: { secretRef: true, status: true, system: true, externalTenantId: true } }));
  if (!row || row.system !== connection.system || row.externalTenantId !== connection.externalTenantId) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  const live = purpose === 'activation' ? row.status === 'DISABLED' : row.status === 'ACTIVE';
  if (!live) throw new AtlasError(row.status === 'FIXTURE' ? 'FIXTURE_CONNECTION_HAS_NO_UPSTREAM' : 'CONNECTION_NOT_LIVE', 'VALIDATION');
  return resolver.resolve(row.secretRef, connection);
}

export interface ConnectionBinding { connectionId: string; system: System; externalTenantId: string; secretRef: string }

/**
 * Explicit binding of a client to an external customer/organization (permission connections:manage on that client),
 * recorded with who and when. It starts DISABLED: reads begin after activation with a health check (task 1.5). One
 * tenant belongs to one client per workspace (unique index): binding a tenant that is already bound — to this or any
 * other client — is rejected and the attempt is recorded in this client's audit; nothing is overwritten. The tenant ID
 * and the secret reference never reach the audit.
 */
export async function bindConnection(db: PrismaClient, actor: Actor, scope: Scope, binding: ConnectionBinding,
  now: Date = new Date()): Promise<{ connectionId: string; status: 'DISABLED' }> {
  assertPermission(actor, scope, 'connections:manage');
  if (!SCOPE_ID_PATTERN.test(binding.connectionId) || !BINDABLE_SYSTEMS.includes(binding.system)
    || !EXTERNAL_TENANT_ID_PATTERN.test(binding.externalTenantId) || !SECRET_REF_PATTERN.test(binding.secretRef)) {
    throw new AtlasError('INVALID_BINDING', 'VALIDATION');
  }
  const correlationId = randomUUID();
  const metadata = { connectionId: binding.connectionId, system: binding.system };
  try {
    await withScope(db, actor, [scope.clientId], async tx => {
      await tx.connection.create({ data: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: binding.connectionId,
        system: binding.system, externalTenantId: binding.externalTenantId, secretRef: binding.secretRef, status: 'DISABLED',
        boundBy: actor.id, boundAt: now }, select: { id: true } });
      await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'connection.bound', correlationId, metadata), select: { id: true } });
    });
  } catch (error) {
    if (uniqueViolation(error) === null) throw error;
    // Connection has two unique keys: its id within the client and (workspace, system, tenant). When the conflicting row
    // belongs to another client, PostgreSQL withholds the details from the confined role (Prisma reports no target), so
    // decide from what this scope can see: an own row with this id, otherwise the tenant is bound elsewhere.
    const sameId = await withScope(db, actor, [scope.clientId], tx => tx.connection.findUnique({
      where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: binding.connectionId } }, select: { id: true } }));
    const code = sameId ? 'CONNECTION_EXISTS' : 'TENANT_ALREADY_BOUND';
    await withScope(db, actor, [scope.clientId], tx => tx.auditEvent.create({
      data: clientAuditData(scope, actor.id, 'connection.bind_rejected', correlationId, { ...metadata, safeErrorCode: code }), select: { id: true } }));
    throw new AtlasError(code, 'CONFLICT');
  }
  return { connectionId: binding.connectionId, status: 'DISABLED' };
}
