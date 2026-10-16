import pg from 'pg';
import { APPLICATION_NAME } from './codes.ts';
import type { QueryClient } from './physical.ts';
import { SOURCE_TABLES } from './seed-plan.ts';
import type { SourceTable } from './seed-plan.ts';

/**
 * Owner-side isolation inventory of the registered sandbox (03 "One scope, eleven alternative source states", rs-b brief
 * §2 B5) and the scoped row-identity read shared with the verifier. Exactness: the ten source tables, Workspace, Client,
 * Actor and ClientMembership have RLS WITHOUT FORCE, so their table owner sees every row of the database; the FORCE tables
 * (finance, fence, action, PowerOffice) are read with the registered workspace/client set and, because Workspace and Client
 * are proven singletons and every row carries a scoped FK, that is every row too. Every query is fixed text; identifiers
 * built from the catalog are quoted with the driver's escapeIdentifier. Nothing here writes.
 */
export type MaintenanceCode = 'REGISTRATION_MISMATCH' | 'UNREGISTERED' | 'ALREADY_REGISTERED' | 'EXTRA_ROWS' | 'LIVE_EGRESS' | 'FK_DEPENDENCY'
  | 'POLICY_NOT_PAUSED' | 'DRAIN_INCOMPLETE' | 'ANOTHER_WRITER' | 'GENERATION_MISMATCH' | 'PLAN_INVALID' | 'OWNER_REQUIRED' | 'UNAUTHORIZED'
  | 'DEADLINE' | 'POSTCHECK_FAILED' | 'INTERNAL_FAILURE';
export class MaintenanceRefusal extends Error {
  readonly code: MaintenanceCode;
  /** The underlying driver error, kept for tests only (never printed: the CLI emits the fixed code alone). */
  readonly underlying: unknown;
  constructor(code: MaintenanceCode, underlying?: unknown) { super(code); this.name = 'MaintenanceRefusal'; this.code = code; this.underlying = underlying; }
}
export const refuse = (code: MaintenanceCode): never => { throw new MaintenanceRefusal(code); };
export interface Scope { readonly workspaceId: string; readonly clientId: string; readonly actorId: string }

const quote = (name: string): string => pg.escapeIdentifier(name);
/** Clears every app.* scope setting, then sets exactly the registered workspace/client/actor (transaction-local). */
export const SET_SCOPE = `SELECT pg_catalog.set_config('app.token_hash', '', true), pg_catalog.set_config('app.poweroffice_connection_id', '', true),
  pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.client_ids', $2, true), pg_catalog.set_config('app.actor_id', $3, true)`;
export const setScope = (c: QueryClient, s: Scope) => c.query(SET_SCOPE, [s.workspaceId, s.clientId, s.actorId]);

const keyText = (row: Record<string, unknown>, cols: readonly string[]): string => cols.map(k => String(row[k])).join('\u0000');
/** Scoped identity keys of every source table (the same canonical form as seed-plan planKeys). */
export async function scopedKeys(c: QueryClient, s: Scope): Promise<Record<SourceTable, string[]>> {
  const out = {} as Record<SourceTable, string[]>;
  for (const t of SOURCE_TABLES) {
    const cols = t.key.map(quote).join(', ');
    const rows = (await c.query(`SELECT ${cols} FROM public.${quote(t.table)} WHERE "workspaceId" = $1 AND "clientId" = $2`, [s.workspaceId, s.clientId])).rows;
    out[t.table] = rows.map(r => keyText(r, t.key)).sort();
  }
  return out;
}
export const sameKeys = (a: Record<SourceTable, string[]>, b: Record<SourceTable, string[]>): boolean =>
  SOURCE_TABLES.every(t => a[t.table].join('\n') === b[t.table].join('\n'));
export const EMPTY_KEYS = (): Record<SourceTable, string[]> => Object.fromEntries(SOURCE_TABLES.map(t => [t.table, []])) as unknown as Record<SourceTable, string[]>;

/** Workspace/Client/Actor are exactly the registered rows; no source row exists outside the registered scope. */
export async function checkSingletons(c: QueryClient, s: Scope): Promise<void> {
  const ws = (await c.query('SELECT id FROM public."Workspace"')).rows;
  if (ws.length !== 1 || ws[0]!.id !== s.workspaceId) refuse('EXTRA_ROWS');
  const clients = (await c.query('SELECT "workspaceId", id FROM public."Client"')).rows;
  if (clients.length !== 1 || clients[0]!.workspaceId !== s.workspaceId || clients[0]!.id !== s.clientId) refuse('EXTRA_ROWS');
  const actors = (await c.query('SELECT "workspaceId", id FROM public."Actor"')).rows;
  if (actors.length !== 1 || actors[0]!.workspaceId !== s.workspaceId || actors[0]!.id !== s.actorId) refuse('EXTRA_ROWS');
  for (const t of SOURCE_TABLES) {
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.${quote(t.table)} WHERE "workspaceId" <> $1 OR "clientId" <> $2`, [s.workspaceId, s.clientId])).rows[0]!.n;
    if (n !== 0) refuse('EXTRA_ROWS');
  }
}
/** A live/bound connector or a non-Atera/Huntress connection anywhere refuses (03 "live egress mode"). */
export async function checkNoLiveEgress(c: QueryClient): Promise<void> {
  const n = (await c.query(`SELECT count(*)::int AS n FROM public."Connection"
    WHERE status <> 'FIXTURE' OR system NOT IN ('atera', 'huntress') OR "boundBy" IS NOT NULL OR "boundAt" IS NOT NULL`)).rows[0]!.n;
  if (n !== 0) refuse('LIVE_EGRESS');
}
/**
 * rc2 (review F4/F8): which pg_stat_activity rows of THIS database count as another writer (the API server and controller
 * must be stopped — RS-B's drain substitute until RS-D DRAIN). Every backend except our own counts, of ANY type (client,
 * parallel/background worker, walsender…), EXCEPT the autovacuum worker: visible as `backend_type = 'autovacuum worker'`
 * to a privileged reader, and — because a role without pg_read_all_stats sees another session's backend_type as NULL —
 * as a row with NULL backend_type AND NULL usesysid. A role-authenticated session always carries its usesysid (visible to
 * every caller), so a NULL type with a user (another role's client) still counts. Autovacuum never writes source rows.
 */
export const OTHER_WRITER_PREDICATE = `NOT (a.pid::text = ANY($1::text[]))
      AND NOT (a.backend_type IS NOT DISTINCT FROM 'autovacuum worker' OR (a.backend_type IS NULL AND a.usesysid IS NULL))`;
export async function checkNoOtherBackend(c: QueryClient, ownPids: readonly string[]): Promise<void> {
  const n = (await c.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity a
    WHERE a.datid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
      AND ${OTHER_WRITER_PREDICATE}`, [ownPids])).rows[0]!.n;
  if (n !== 0) refuse('ANOTHER_WRITER');
}
/**
 * RS-D-A (owner decision D2, rs-d brief A §5): the registered server S and controller C stay up through a switch. The switch admits,
 * besides its own backends and autovacuum (OTHER_WRITER_PREDICATE), ONLY sessions of the configured runtime role with S's fixed
 * application_name and of the configured reader role with C's — and only while idle: no pg_locks row (every transaction holds its
 * virtualxid lock; a session-level advisory lock shows too) and no backend xid/xmin. usename, application_name, backend_xid/xmin and
 * pg_locks are visible to a non-privileged owner role (PG17). Anything else is ANOTHER_WRITER.
 */
export interface RegisteredRoles { readonly runtime: string; readonly reader: string }
export async function checkRegisteredIdle(c: QueryClient, ownPids: readonly string[], roles: RegisteredRoles): Promise<void> {
  const n = (await c.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity a
    WHERE a.datid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
      AND ${OTHER_WRITER_PREDICATE}
      AND NOT (((a.usename = $2 AND a.application_name = $3) OR (a.usename = $4 AND a.application_name = $5))
        AND a.backend_xid IS NULL AND a.backend_xmin IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid = a.pid))`,
  [ownPids, roles.runtime, APPLICATION_NAME.runtime, roles.reader, APPLICATION_NAME.reader])).rows[0]!.n;
  if (n !== 0) refuse('ANOTHER_WRITER');
}
/**
 * FK dependencies (03: "Any FK dependency outside the source allowlist makes replacement refuse rather than cascading"):
 * every FK from a non-allowlisted table into an allowlisted one must be RESTRICT/NO ACTION, and no row of such a table may
 * reference a scoped source row. The DELETE's own RESTRICT check remains the backstop.
 */
export async function checkFkDependencies(c: QueryClient, s: Scope): Promise<void> {
  const tables = SOURCE_TABLES.map(t => `public.${quote(t.table)}`);
  const fks = (await c.query(`SELECT k.conrelid::regclass::text AS child, k.confrelid::regclass::text AS parent, k.confdeltype AS del,
      (SELECT pg_catalog.array_agg(a.attname::text ORDER BY x.n) FROM unnest(k.conkey) WITH ORDINALITY x(att, n)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.att) AS child_cols,
      (SELECT pg_catalog.array_agg(a.attname::text ORDER BY x.n) FROM unnest(k.confkey) WITH ORDINALITY x(att, n)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.att) AS parent_cols
    FROM pg_catalog.pg_constraint k
    WHERE k.contype = 'f' AND k.confrelid = ANY($1::regclass[]) AND NOT (k.conrelid = ANY($1::regclass[]))
    ORDER BY 1, 2, k.conname`, [tables])).rows as { child: string; parent: string; del: string; child_cols: string[]; parent_cols: string[] }[];
  for (const fk of fks) {
    if (fk.del !== 'a' && fk.del !== 'r') refuse('FK_DEPENDENCY');
    const match = fk.child_cols.map((col, i) => `x.${quote(col)} = p.${quote(fk.parent_cols[i]!)}`).join(' AND ');
    const n = (await c.query(`SELECT count(*)::int AS n FROM ${fk.child} x WHERE EXISTS (SELECT 1 FROM ${fk.parent} p
      WHERE p."workspaceId" = $1 AND p."clientId" = $2 AND ${match})`, [s.workspaceId, s.clientId])).rows[0]!.n;
    if (n !== 0) refuse('FK_DEPENDENCY');
  }
}
/** Policy of the registered admission exactly PAUSED (rc2, review F2: INACTIVE is refused — ACTIVE→INACTIVE is a legal
 *  owner revision, so INACTIVE does not prove that nothing was admitted); no unsettled attempt. */
export async function checkPolicyQuiescent(c: QueryClient, s: Scope, admissionId: string, lock: boolean): Promise<void> {
  const pol = (await c.query(`SELECT "admissionId"::text AS a, state FROM public."RemoteAskPolicy" WHERE "workspaceId" = $1${lock ? ' FOR UPDATE' : ''}`,
    [s.workspaceId])).rows;
  if (pol.length !== 1 || pol[0]!.a !== admissionId) refuse('REGISTRATION_MISMATCH');
  if (pol[0]!.state !== 'PAUSED') refuse('POLICY_NOT_PAUSED');
  const open = (await c.query(`SELECT count(*)::int AS n FROM public."RemoteAskAttempt" WHERE "workspaceId" = $1 AND state = 'EGRESS_COMMITTED'`,
    [s.workspaceId])).rows[0]!.n;
  if (open !== 0) refuse('DRAIN_INCOMPLETE');
}
/** Finance, audit, identity and history fingerprint (03: "never deleted/reset/rewritten by fixture replacement"). */
export const PRESERVED_TABLES = ['RemoteAskPolicy', 'RemoteAskClientAdmission', 'RemoteAskPeriodCounter', 'RemoteAskAttempt', 'AuditEvent',
  'SecurityAuditEvent', 'ToolExecution', 'Actor', 'ClientMembership', 'ApiToken', 'Workspace', 'Client', 'RevalSandboxRegistration'] as const;
export async function preservedFingerprint(c: QueryClient): Promise<string> {
  const parts: string[] = [];
  for (const t of PRESERVED_TABLES) {
    const r = (await c.query(`SELECT count(*)::text || ':' || coalesce(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      string_agg(pg_catalog.to_jsonb(x)::text, E'\\n' ORDER BY pg_catalog.to_jsonb(x)::text), 'UTF8')), 'hex'), '') AS f FROM public.${quote(t)} x`)).rows[0]!;
    parts.push(`${t}=${String(r.f)}`);
  }
  return parts.join(';');
}
