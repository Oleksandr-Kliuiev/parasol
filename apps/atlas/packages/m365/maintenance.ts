import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermissions } from '../core/contracts.ts';
import { hasCurrentClientPermissions } from '../auth/authority.ts';
import { scopeContext } from '../graph/scope-context.ts';
import { withScope } from '../graph/scoped-db.ts';
import { withDenialAudit } from './denial.ts';
import { assertConfinedRunner, RUNNER_ROLE_CHECK_SQL } from './maintenance-role.ts';
import type { RunnerRoleFacts } from './maintenance-role.ts';

/**
 * Scoped M365 retention pass, `m365-cleanup` (02 §6, brief RC3 "Maintenance service and bounded execution"):
 *  1. events:ingest + connections:manage on the authenticated actor (boundary);
 *  2. configuration, resolved lazily (the ordinary API never needs it): ATLAS_M365_CLEANUP_RUNNER_SECRET_REF=env://NAME
 *     names the runner URL; ATLAS_M365_CLEANUP_TIMEOUT_MS is an integer 30000..600000 (default 300000). The runner URL's
 *     complete target (protocol, lower-case host text without DNS, effective port, database path, every query option) must
 *     equal the runtime URL's — only username/password differ — and the URL actually used is the RUNTIME URL with the
 *     runner credentials substituted. The runtime URL comes from the service factory's own pairing (openRuntimeDatabase),
 *     never from a caller or a flag;
 *  3. runner-perspective confinement (maintenance-role.ts) on the separate EXECUTE-only runner connection;
 *  4. the actor's CURRENT authority on the runtime database, immediately before the runner transaction (a failure is one
 *     workspace denial and no routine call). Residual gap, by design: a revoke committing after this check and before the
 *     runner transaction completes does not stop the pass (no distributed fence); the routine still confines scope and
 *     deletes only expired rows, and an M365 disable never revokes maintenance eligibility;
 *  5. ONE runner transaction: SET LOCAL statement_timeout (configured), lock_timeout 5000ms, the verified one-client scope
 *     and actor, then atlas_m365_cleanup(correlationId) — Connection-first locks, atomic pointer withdrawal + expired payload
 *     deletion + allowlisted retention.completed audit. The transaction timeout exceeds the statement timeout by a fixed
 *     guard; any timeout rolls the whole pass back. This is a time bound, not row batching.
 */
export const CLEANUP_PERMISSIONS = Object.freeze(['events:ingest', 'connections:manage'] as const);
export const CLEANUP_RUNNER_REF_VARIABLE = 'ATLAS_M365_CLEANUP_RUNNER_SECRET_REF';
export const CLEANUP_TIMEOUT_VARIABLE = 'ATLAS_M365_CLEANUP_TIMEOUT_MS';
export const CLEANUP_TIMEOUT_DEFAULT_MS = 300_000;
export const CLEANUP_TIMEOUT_MIN_MS = 30_000;
export const CLEANUP_TIMEOUT_MAX_MS = 600_000;
export const CLEANUP_LOCK_TIMEOUT_MS = 5_000;
export const CLEANUP_TRANSACTION_GUARD_MS = 5_000;
export const CLEANUP_DENIED_EVENT = 'm365.cleanup_denied';
type Env = Readonly<Record<string, string | undefined>>;

const configInvalid = (reason: string) => new AtlasError('M365_CLEANUP_CONFIG_INVALID', 'PERMANENT', { reason });

/** The runtime Prisma client together with the URL it was built from; only openRuntimeDatabase pairs them. */
export interface RuntimeDatabase { readonly db: PrismaClient }
const runtimeUrls = new WeakMap<RuntimeDatabase, string>();
export function openRuntimeDatabase(url: string): RuntimeDatabase {
  const runtime: RuntimeDatabase = Object.freeze({ db: new PrismaClient({ datasourceUrl: url }) });
  runtimeUrls.set(runtime, url);
  return runtime;
}

export function cleanupTimeoutMs(env: Env): number {
  const raw = env[CLEANUP_TIMEOUT_VARIABLE];
  if (raw === undefined || raw === '') return CLEANUP_TIMEOUT_DEFAULT_MS;
  if (!/^[1-9][0-9]{4,5}$/.test(raw) || Number(raw) < CLEANUP_TIMEOUT_MIN_MS || Number(raw) > CLEANUP_TIMEOUT_MAX_MS) throw configInvalid('timeout');
  return Number(raw);
}

interface Target { protocol: string; host: string; port: string; path: string; query: string }
function parseDatabaseUrl(text: string, which: string): { url: URL; target: Target } {
  let url: URL;
  try { url = new URL(text); } catch { throw configInvalid(`${which}Url`); }
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') || url.hash !== '' || url.hostname === '' || url.username === ''
    || url.password === '' || url.pathname.length < 2 || url.pathname.slice(1).includes('/')) throw configInvalid(`${which}Url`);
  const query = [...url.searchParams.entries()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return { url, target: { protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port === '' ? '5432' : url.port, path: url.pathname,
    query: JSON.stringify(query) } };
}
/**
 * The URL the runner connects with: the runtime URL, cloned, with only the configured runner credentials substituted —
 * after the configured runner target was proven identical to the runtime target. Never a second target.
 */
export function runnerUrlFor(runtimeUrl: string, configuredRunnerUrl: string): string {
  const runtime = parseDatabaseUrl(runtimeUrl, 'runtime'); const runner = parseDatabaseUrl(configuredRunnerUrl, 'runner');
  for (const field of ['protocol', 'host', 'port', 'path', 'query'] as const) if (runtime.target[field] !== runner.target[field]) throw configInvalid('targetMismatch');
  if (runner.url.username === runtime.url.username) throw configInvalid('sameRole');
  const actual = new URL(runtimeUrl);
  actual.username = runner.url.username; actual.password = runner.url.password;
  return actual.toString();
}
export function resolveRunnerUrl(runtimeUrl: string, env: Env): string {
  const name = /^env:\/\/([A-Z][A-Z0-9_]{0,99})$/.exec(env[CLEANUP_RUNNER_REF_VARIABLE] ?? '')?.[1];
  const value = name ? env[name] : undefined;
  if (!value) throw configInvalid('runnerRef');
  return runnerUrlFor(runtimeUrl, value);
}

/** SQLSTATE of a Prisma raw-query failure, or a Prisma interactive-transaction timeout. */
function timedOut(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  const state = typeof e?.meta?.code === 'string' ? e.meta.code : /Code: `([0-9A-Z]{5})`/.exec(String(e?.message ?? ''))?.[1];
  return state === '57014' || state === '55P03' || e?.code === 'P2028';
}

export interface CleanupConnectionCounts {
  connectionId: string; clearedPointers: number; deletedDirectoryObjects: number; deletedGenerations: number; deletedMemberships: number;
  deletedLeaves: number; deletedAttempts: number; deletedEvidence: number;
}
export type CleanupResult = { status: 'COMPLETED'; correlationId: string; connections: CleanupConnectionCounts[] }
  | { status: 'FAILED'; correlationId: string; safeErrorCode: string };
export interface CleanupOptions { env?: Env; correlationId?: string }

export function runM365Cleanup(runtime: RuntimeDatabase, actor: Actor, scope: Scope, options: CleanupOptions = {}): Promise<CleanupResult> {
  const db = runtime.db;
  return withDenialAudit(db, actor, scope, CLEANUP_DENIED_EVENT, async () => {
    assertPermissions(actor, scope, CLEANUP_PERMISSIONS);
    const ctx = scopeContext(actor, [scope.clientId]);
    const runtimeUrl = runtimeUrls.get(runtime);
    if (!runtimeUrl) throw configInvalid('runtimePairing');
    const env = options.env ?? process.env;
    const timeoutMs = cleanupTimeoutMs(env);
    const runnerUrl = resolveRunnerUrl(runtimeUrl, env);
    const correlationId = options.correlationId ?? randomUUID();
    const runner = new PrismaClient({ datasourceUrl: runnerUrl });
    try {
      let facts: RunnerRoleFacts | undefined;
      try { facts = (await runner.$queryRawUnsafe<RunnerRoleFacts[]>(RUNNER_ROLE_CHECK_SQL))[0]; }
      catch { throw new AtlasError('M365_CLEANUP_RUNNER_UNAVAILABLE', 'PERMANENT'); }
      assertConfinedRunner(facts);
      const current = await withScope(db, actor, [scope.clientId], tx => hasCurrentClientPermissions(tx, actor, scope.clientId, CLEANUP_PERMISSIONS));
      if (!current) throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
      try {
        const result = await runner.$transaction(async tx => {
          await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true), set_config('lock_timeout', ${`${CLEANUP_LOCK_TIMEOUT_MS}ms`}, true),
            set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.client_ids', ${ctx.clientIds}, true), set_config('app.actor_id', ${actor.id}, true)`;
          const [row] = await tx.$queryRaw<{ result: { connections: CleanupConnectionCounts[] } }[]>`SELECT public.atlas_m365_cleanup(${correlationId}) AS result`;
          return row!.result;
        }, { timeout: timeoutMs + CLEANUP_TRANSACTION_GUARD_MS, maxWait: 10_000 });
        return { status: 'COMPLETED', correlationId, connections: result.connections.map(c => ({ connectionId: String(c.connectionId),
          clearedPointers: Number(c.clearedPointers), deletedDirectoryObjects: Number(c.deletedDirectoryObjects), deletedGenerations: Number(c.deletedGenerations),
          deletedMemberships: Number(c.deletedMemberships), deletedLeaves: Number(c.deletedLeaves), deletedAttempts: Number(c.deletedAttempts),
          deletedEvidence: Number(c.deletedEvidence) })) };
      } catch (error) {
        // The whole pass rolled back: pointers, payload and audit are unchanged. Read expiry continues regardless.
        return { status: 'FAILED', correlationId, safeErrorCode: timedOut(error) ? 'M365_CLEANUP_TIMEOUT' : 'M365_CLEANUP_FAILED' };
      }
    } finally {
      await runner.$disconnect().catch(() => undefined);
    }
  });
}
