import { lstat, readFile, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { bounded, DeadlineExceeded } from './deadline.ts';
import type { Endpoint, PhysicalTuple } from './private-frames.ts';

/**
 * Physical binding of EVERY RS-A database connection (reader, S runtime, E owner; brief §3), BEFORE any effecting query and
 * before S listens: the approved unix-socket endpoint and the recorded physical tuple, checked on the filesystem, through
 * the connection itself (`inet_server_addr() IS NULL` proves a unix-socket session), and again on the filesystem after
 * connecting. Every queried fact, including the floor epoch of pg_postmaster_start_time(), must EQUAL the recorded tuple
 * (whose start is also the postmaster.pid start line): no tolerance. Copied UUIDs prove nothing; this tuple is the binding.
 * Any failure destroys the connection before another statement. Steps 1–6 share ONE budget (`budgetMs`): every await is
 * bounded by the same absolute instant, the session's statement_timeout equals the remaining budget (so a stalled backend
 * is cancelled server-side too) and a late client is destroyed. Errors are closed classes: PhysicalMismatchError (→
 * REGISTRATION_MISMATCH), PhysicalAuthError (only the SQLSTATE of a connect-time credential/role refusal: 28P01, 28000,
 * 42501; never server text) and DeadlineExceeded. No TCP host can be expressed: the client gets `host: socketDir` only.
 */
export class PhysicalMismatchError extends Error {
  readonly step: string;
  constructor(step: string) { super('PHYSICAL_MISMATCH'); this.name = 'PhysicalMismatchError'; this.step = step; }
}
export class PhysicalAuthError extends Error {
  readonly sqlState: '28P01' | '28000' | '42501';
  constructor(sqlState: PhysicalAuthError['sqlState']) { super('PHYSICAL_AUTH'); this.name = 'PhysicalAuthError'; this.sqlState = sqlState; }
}
const mismatch = (step: string): never => { throw new PhysicalMismatchError(step); };
/** The SQLSTATE of a server error (pg DatabaseError carries `severity`); undefined for connection/IO errors. */
export function sqlStateOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; severity?: unknown };
  return typeof e?.severity === 'string' && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
}
/** A connect rejection: a credential/role refusal keeps ONLY its SQLSTATE; anything else is a physical mismatch. */
export function connectFailure(error: unknown): PhysicalAuthError | PhysicalMismatchError {
  const s = sqlStateOf(error);
  return s === '28P01' || s === '28000' || s === '42501' ? new PhysicalAuthError(s) : new PhysicalMismatchError('connect');
}

export interface QueryClient { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
export interface ConnectOptions {
  readonly host: string; readonly port: number; readonly database: string; readonly user: string; readonly password: string;
  readonly application_name: string; readonly connectionTimeoutMillis: number;
  /** Session statement_timeout (ms) = the remaining budget: a stalled backend is cancelled server-side as well. */
  readonly statement_timeout: number;
}
export interface PhysicalDeps {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  isPidLive(pid: number): boolean;
  connect(options: ConnectOptions): Promise<QueryClient>;
}
export const nodePhysicalDeps = (connect: PhysicalDeps['connect']): PhysicalDeps => ({
  lstat: p => lstat(p), realpath: p => realpath(p), readFile: p => readFile(p, 'utf8'),
  isPidLive: pid => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
  connect,
});
export interface PhysicalExpectation {
  readonly endpoint: Endpoint; readonly physical: PhysicalTuple; readonly role: string; readonly applicationName: string;
  /** Total time for steps 1–6 (or a recheck), from the call. */
  readonly budgetMs: number;
  /**
   * A FIXED cap of the connection step alone (E: brief §6 `min(300, DE − now)`), distinct from — never widened by — the
   * whole-binding budget: the pg `connectionTimeoutMillis` and the bound of the connect await are min(this, remaining budget).
   */
  readonly connectTimeoutMs?: number;
}
export interface Observed {
  readonly systemIdentifier: string; readonly databaseOid: string; readonly postmasterStartTime: string; readonly backendPid: string;
  readonly sessionUser: string; readonly unixSocket: true;
}
export const PHYSICAL_QUERY = `SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier,
  (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())::text AS database_oid,
  pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.pg_postmaster_start_time()))::bigint::text AS start_epoch,
  pg_catalog.current_database()::text AS database, session_user::text AS session_user,
  pg_catalog.inet_server_addr() IS NULL AS unix_socket, pg_catalog.pg_backend_pid()::text AS backend_pid`;

/** Filesystem facts (steps 1–3): socket dir, socket dev/ino, postmaster.pid lines, live postmaster. */
export async function checkFilesystem(exp: PhysicalExpectation, deps: PhysicalDeps): Promise<void> {
  const { socketDir, port } = exp.endpoint; const p = exp.physical;
  if (await deps.realpath(socketDir).catch(() => '') !== socketDir) mismatch('socket-dir-path');
  for (let dir = socketDir; ; dir = dirname(dir)) {
    const st = await deps.lstat(dir).catch(() => mismatch('socket-dir'));
    if (!st.isDirectory() || st.isSymbolicLink()) mismatch('socket-dir');
    if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) mismatch('socket-dir-writable');
    if (dir === '/') break;
  }
  const sock = await deps.lstat(`${socketDir}/.s.PGSQL.${port}`).catch(() => mismatch('socket'));
  if (!sock.isSocket() || String(sock.dev) !== p.socketDevice || String(sock.ino) !== p.socketInode) mismatch('socket');
  const text = await deps.readFile(`${p.dataDirectory}/postmaster.pid`).catch(() => mismatch('pid-file'));
  const lines = text.split('\n');
  if (lines.length < 5 || lines[0] !== p.postmasterPid || lines[1] !== p.dataDirectory || lines[2] !== p.postmasterStartTime
    || lines[3]!.trim() !== String(port) || lines[4] !== socketDir) mismatch('pid-file');
  if (!deps.isPidLive(Number(p.postmasterPid))) mismatch('postmaster');
}
/** Steps 1–6 within `budgetMs`; returns the connected client (no other statement ran) and the observed tuple. */
export async function verifyPhysicalEndpoint(exp: PhysicalExpectation, password: string, deps: PhysicalDeps): Promise<{ client: QueryClient; observed: Observed }> {
  const until = performance.now() + exp.budgetMs;
  await bounded(checkFilesystem(exp, deps), until);
  const left = Math.floor(until - performance.now());
  if (left < 1) throw new DeadlineExceeded();
  const connectMs = Math.max(1, Math.min(left, exp.connectTimeoutMs ?? left));
  const client = await bounded(deps.connect({ host: exp.endpoint.socketDir, port: exp.endpoint.port, database: exp.endpoint.database, user: exp.role,
    password, application_name: exp.applicationName, connectionTimeoutMillis: connectMs, statement_timeout: left }).catch((e: unknown) => { throw connectFailure(e); }),
  performance.now() + connectMs, late => { void destroy(late); });
  try {
    const row = (await bounded(client.query(PHYSICAL_QUERY), until)).rows[0];
    if (!sameTuple(exp, row) || typeof row!.backend_pid !== 'string') mismatch('database');
    await bounded(checkFilesystem(exp, deps), until);
    return { client, observed: { systemIdentifier: row!.system_identifier as string, databaseOid: row!.database_oid as string,
      postmasterStartTime: row!.start_epoch as string, backendPid: row!.backend_pid as string, sessionUser: row!.session_user as string, unixSocket: true } };
  } catch (error) {
    await destroy(client);
    throw error instanceof PhysicalMismatchError || error instanceof DeadlineExceeded ? error : new PhysicalMismatchError('database');
  }
}
const sameTuple = (exp: PhysicalExpectation, row: Record<string, unknown> | undefined): boolean => !!row
  && row.system_identifier === exp.physical.systemIdentifier && row.database_oid === exp.physical.databaseOid
  && row.start_epoch === exp.physical.postmasterStartTime && row.database === exp.endpoint.database && row.session_user === exp.role
  && row.unix_socket === true;
/**
 * The recheck of an OPEN connection (every IDENTITY): steps 1–3, the fixed query and 1–3 again within `budgetMs`. false on any
 * mismatch, error or timeout; the caller then destroys the client (an abandoned query must not stay in flight).
 */
export async function recheckPhysical(exp: PhysicalExpectation, client: QueryClient, deps: PhysicalDeps): Promise<boolean> {
  const until = performance.now() + exp.budgetMs;
  try {
    await bounded(checkFilesystem(exp, deps), until);
    const row = (await bounded(client.query(PHYSICAL_QUERY), until)).rows[0];
    if (!sameTuple(exp, row)) return false;
    await bounded(checkFilesystem(exp, deps), until);
    return true;
  } catch { return false; }
}
async function destroy(client: QueryClient): Promise<void> {
  const stream = (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream;
  try { stream?.destroy(); } catch { /* already gone */ }
  await client.end().catch(() => undefined);
}
export { destroy as destroyClient };
