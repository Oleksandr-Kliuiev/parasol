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

// The runtime-role self-check (protected tables, Stage 2 grants, cleanup routine owner) lives in runtime-role.ts.
export { PROTECTED_TABLES, RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from './runtime-role.ts';
export type { RuntimeRoleFacts } from './runtime-role.ts';
