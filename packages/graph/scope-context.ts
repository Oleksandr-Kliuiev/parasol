import type { Actor } from '../core/contracts.ts';
import { AtlasError, allowedClientIds } from '../core/contracts.ts';

/**
 * Prisma-free half of the scoped database access: how the RLS context is derived and checked. Shared by
 * scoped-db.ts (Prisma), scripts/pg17-check.ts (plain pg) and the tests, so every path sets exactly the same context.
 */

/** Identifier policy for scope values that travel through the comma-separated RLS setting. */
export const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface ScopeContext { workspaceId: string; clientIds: string }

/** Validates the requested clients against the actor's memberships and the identifier policy. Never trusts the caller. */
export function scopeContext(actor: Actor, clientIds: string[]): ScopeContext {
  if (!SCOPE_ID_PATTERN.test(actor.workspaceId)) throw new AtlasError('INVALID_SCOPE_ID', 'VALIDATION');
  const allowed = new Set(allowedClientIds(actor));
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) throw new AtlasError('SCOPE_DENIED', 'SCOPE');
  for (const id of unique) {
    if (!SCOPE_ID_PATTERN.test(id)) throw new AtlasError('INVALID_SCOPE_ID', 'VALIDATION');
    if (!allowed.has(id)) throw new AtlasError('SCOPE_DENIED', 'SCOPE');
  }
  return { workspaceId: actor.workspaceId, clientIds: unique.join(',') };
}

/**
 * Workspace-only context: the actor's workspace and an explicitly empty client list, so every client-scoped table stays
 * invisible. For workspace-level rows only (the security audit of denials, whose policy follows the workspace alone).
 */
export function workspaceContext(actor: Actor): ScopeContext {
  if (!SCOPE_ID_PATTERN.test(actor.workspaceId)) throw new AtlasError('INVALID_SCOPE_ID', 'VALIDATION');
  return { workspaceId: actor.workspaceId, clientIds: '' };
}

/** set_config(..., true) is the parameterised SET LOCAL: the context ends with the transaction, never with the connection. */
export const SET_SCOPE_SQL = `SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`;

/** Every table protected with row-level security (v1.1 migration + 202610071600 identities). The runtime check covers all of them. */
export const PROTECTED_TABLES: readonly string[] = [
  'Workspace', 'Client', 'Entity', 'Person', 'Device', 'Connection', 'ExternalEntity', 'EntityLink', 'RawEvent', 'DecisionRun',
  'Observation', 'SyncState', 'ToolExecution', 'AuditEvent', 'SecurityAuditEvent', 'Approval', 'Actor', 'ClientMembership', 'ApiToken'
];
const protectedTableList = PROTECTED_TABLES.map(t => `'${t}'`).join(',');

/**
 * Facts about the current role that decide whether RLS can confine it:
 *   superuser / bypassRls   — policies are skipped entirely;
 *   ownsProtectedTables     — the role owns, directly or through role membership (pg_has_role MEMBER), any protected table;
 *   unprotectedTables       — protected tables that are missing or have RLS disabled in the current schema.
 */
export const RUNTIME_ROLE_CHECK_SQL = `
  WITH protected AS (SELECT unnest(ARRAY[${protectedTableList}]) AS relname),
       present AS (SELECT c.relname, c.relrowsecurity, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname IN (SELECT relname FROM protected))
  SELECT r.rolsuper AS "superuser", r.rolbypassrls AS "bypassRls",
         EXISTS (SELECT 1 FROM present p WHERE pg_has_role(r.oid, p.relowner, 'MEMBER')) AS "ownsProtectedTables",
         (SELECT count(*)::int FROM protected t LEFT JOIN present p ON p.relname = t.relname WHERE p.relname IS NULL OR NOT p.relrowsecurity) AS "unprotectedTables"
  FROM pg_roles r WHERE r.rolname = current_user`;
export interface RuntimeRoleFacts { superuser: boolean; bypassRls: boolean; ownsProtectedTables: boolean; unprotectedTables: number }
export function assertConfinedRuntimeRole(facts: RuntimeRoleFacts | undefined): void {
  if (!facts) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'no role facts' });
  if (facts.superuser) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'superuser' });
  if (facts.bypassRls) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'BYPASSRLS' });
  if (facts.ownsProtectedTables) throw new AtlasError('RUNTIME_ROLE_BYPASSES_RLS', 'PERMANENT', { reason: 'owns protected tables' });
  if (Number(facts.unprotectedTables) > 0) throw new AtlasError('RLS_NOT_ENABLED', 'PERMANENT', { unprotectedTables: String(facts.unprotectedTables) });
}
