import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { scopeContext, workspaceContext, RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from './scope-context.ts';
import type { RuntimeRoleFacts } from './scope-context.ts';
export { SCOPE_ID_PATTERN, SET_SCOPE_SQL, RUNTIME_ROLE_CHECK_SQL, scopeContext, workspaceContext, assertConfinedRuntimeRole } from './scope-context.ts';
export type { ScopeContext, RuntimeRoleFacts } from './scope-context.ts';

/**
 * Scoped database access. Every read or write of client data goes through withScope(): one transaction, context set
 * as the first statement with set_config(..., true) — the parameterised form of SET LOCAL — so the row-level security
 * policies of the v1.1 migration see the actor's workspace and allowed clients. The context ends with the transaction,
 * so a pooled connection carries nothing over to the next request.
 */

/** Startup self-check for API and worker: refuse to serve client data through a role that RLS cannot confine. */
export async function assertRuntimeRole(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL);
  assertConfinedRuntimeRole(rows[0]);
}

export async function withScope<T>(db: PrismaClient, actor: Actor, clientIds: string[],
  fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const ctx = scopeContext(actor, clientIds);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.client_ids', ${ctx.clientIds}, true)`;
    return fn(tx);
  });
}

/**
 * Target of a unique violation (Prisma P2002) as a comma-separated field or constraint list, or null for any other error.
 * Lets a service turn a lost race or a duplicate binding into a decided outcome instead of an unexpected error.
 */
export function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return null;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.join(',') : String(target ?? '');
}

/** Same transaction discipline at workspace level: no client in scope (workspaceContext). Used for the security audit. */
export async function withWorkspaceScope<T>(db: PrismaClient, actor: Actor,
  fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const ctx = workspaceContext(actor);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.client_ids', ${ctx.clientIds}, true)`;
    return fn(tx);
  });
}
