import pg from 'pg';

/**
 * Deterministic two-session orderings for the PostgreSQL race tests: a session's next statement is started without
 * awaiting it, and the test proceeds only once the server shows that session WAITING on a lock (pg_locks, granted =
 * false) — never on a sleep. pg_locks and the pid/datname columns of pg_stat_activity are readable by every role.
 */
export interface Session { client: pg.Client; pid: number }

export async function openSession(url: string): Promise<Session> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return { client, pid: (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number };
}
/** BEGIN plus the transaction-local client scope, as withScope sets it. */
export async function beginScoped(s: Session, clientId = 'c1', workspaceId = 'w'): Promise<void> {
  await s.client.query('BEGIN');
  await s.client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [workspaceId, clientId]);
}
/** A statement (or async step) in flight: its outcome is captured, so a rejection is never unhandled. */
export interface InFlight<T> { settled(): boolean; result(): Promise<T> }
export function inFlight<T>(step: () => Promise<T>): InFlight<T> {
  let done = false;
  const p = step().finally(() => { done = true; });
  p.catch(() => undefined);
  return { settled: () => done, result: () => p };
}

// An observer inside an open transaction keeps its first pg_stat_activity snapshot until the transaction ends, so a backend
// connected later (a lazily opened pool connection) would never appear: discard the snapshot before every poll.
const blocked = async (observer: pg.Client, pid: number | null) => (await observer.query('SELECT pg_stat_clear_snapshot()'), await observer.query(pid === null
  ? `SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = current_database() AND a.pid <> pg_backend_pid()) AS b`
  : `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted) AS b`, pid === null ? [] : [pid])).rows[0].b as boolean;

/** Resolves once `pid` (or, with null, any other backend of this database) waits on a lock; fails after `timeoutMs`. */
export async function waitUntilBlocked(observer: pg.Client, pid: number | null, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await blocked(observer, pid))) {
    if (Date.now() > deadline) throw new Error(`session ${pid ?? '(any)'} never waited on a lock`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function rollbackQuietly(s: Session): Promise<void> { await s.client.query('ROLLBACK').catch(() => undefined); }
