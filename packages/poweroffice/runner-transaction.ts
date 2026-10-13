import { AtlasError } from '../core/contracts.ts';
import { powerOfficeError } from './contracts.ts';
import { sendCancelRequest } from './runner-cancel.ts';
import type { PowerOfficeErrorCode } from './contracts.ts';

/**
 * The ONE original monotonic 10 s budget of a PowerOffice cleanup runner transaction (docs/stage4/03_DATA_AND_CONCURRENCY.md
 * "Explicit bounded maintenance"; Astra S4C-rc1 R1/R2, S4C-rc2 R1, S4C-rc3 F1/F2; phase map in S4C_RC4_IMPLEMENTATION_REPORT.md).
 * The deadline is fixed once, before the runner connection exists, and never reset. ONE explicit `pg` connection (never a
 * pool), closed at the end. Per phase:
 *   P1 connect/login: min(budget, URL connect_timeout, Prisma's 5 s default) closes the socket; PostgreSQL issues no cancel
 *      key before login completes, so login code already running on the server is not client-cancellable (residual).
 *   P2–P8 every later statement (setup reads/installs, BEGIN, body, COMMIT, ROLLBACK): a deadline WATCHDOG armed before
 *      connect sends this backend's protocol CancelRequest at the original deadline while any statement is in flight (the
 *      server ends it with 57014 whatever it waits on), then destroys the socket if it does not settle within
 *      CANCEL_GRACE_MS. The client awaits that settlement; it never returns while its statement runs by choice.
 *   P2 the first setup read is relation-free (current_setting); P3 installs, as SESSION settings BEFORE BEGIN, the inherited-
 *      or-stricter statement_timeout, lock_timeout 1000 ms and transaction_timeout = remaining − ANCHOR_RESERVE_MS, verified
 *      in pg_settings (source session) — so every later setup statement is also server-bounded and BEGIN arms exactly that
 *      transaction timer even when role/database/startup settings carry another value (an in-transaction set cannot
 *      replace an armed timer). From computing the value to the BEGIN reply ≤ ANCHOR_RESERVE_MS, else fail closed.
 *   P5–P7 inside: budget check + statement_timeout ≤ remaining before each statement; while the client is idle the server's
 *      transaction timer terminates the session; COMMIT (incl. deferred triggers) stays under that timer. The only window
 *      is PostgreSQL's atomic commit point (interrupts held while the commit record is written).
 * Classification uses structured fields and the runner's own timers only, never message text, and echoes nothing: own
 * budget marker; SQLSTATE 57014/55P03/25P03/25P04 (from the failed statement or the session's first structured terminal
 * cause); Prisma P2024/P2028 / initialization P2024/P1002/P1001; a generic connection loss after the watchdog fired or
 * after the EFFECTIVE (possibly stricter) transaction timer armed at BEGIN was due; or any failure in the original
 * deadline window [deadline − reserve, deadline] → POWEROFFICE_CLEANUP_TIMEOUT. 40P01/40001/P2034 → DB_CONFLICT; refused
 * connection/authentication/unknown role or database → RUNTIME_NOT_READY; an earlier generic disconnect or anything else →
 * CLEANUP_FAILED. Never retried. Requires PostgreSQL 17 (transaction_timeout).
 */
export const CLEANUP_BUDGET_MS = 10_000;
export const CLEANUP_LOCK_TIMEOUT_MS = 1_000;
export const ANCHOR_RESERVE_MS = 250;
/** Prisma's documented connect_timeout default (seconds) — the paired URL's semantics are kept for this transport. */
export const DEFAULT_CONNECT_TIMEOUT_S = 5;

export interface Budget { readonly left: () => number }
/** Starts the original budget now (before the runner connection exists). */
export function startBudget(now: () => number = () => performance.now()): Budget {
  const deadline = now() + CLEANUP_BUDGET_MS;
  return Object.freeze({ left: () => Math.floor(deadline - now()) });
}

/** Private markers: the client observed the budget exhausted / its own connect timer expired (never raw, never exported). */
const budgetMarkers = new WeakSet<object>();
function spent(): never { const marker = powerOfficeError('POWEROFFICE_CLEANUP_TIMEOUT'); budgetMarkers.add(marker); throw marker; }

const TIMEOUT_STATES: ReadonlySet<string> = new Set(['57014', '55P03', '25P03', '25P04']);
const TIMEOUT_CODES: ReadonlySet<unknown> = new Set(['P2024', 'P2028']);
/** Prisma initialization codes of a connection/login that did not complete in time (kept from RC2 for any Prisma caller). */
const INIT_TIMEOUT_CODES: ReadonlySet<unknown> = new Set(['P2024', 'P1002', 'P1001']);
const PASSED: ReadonlySet<string> = new Set(['POWEROFFICE_RUNTIME_NOT_READY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_CLEANUP_FAILED']);
/** SQLSTATE from structured fields only: Prisma's meta.code, or a driver error's own 5-character code. Never the message. */
function structuredState(error: unknown): string | undefined {
  const e = error as { code?: unknown; meta?: { code?: unknown }; clientVersion?: unknown } | null;
  if (typeof e?.meta?.code === 'string') return e.meta.code;
  return e?.clientVersion === undefined && typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined;
}
/**
 * Evidence the runner itself recorded (S4C-rc3 F2, S4C-rc4 F1/F2; decision table in S4C_RC5_IMPLEMENTATION_REPORT.md §2).
 * `terminal`: the FIRST session terminal event (client clock, budget left then, its SQLSTATE when structured — pg often
 * reports idle termination as a generic Error). `failedAt`/`failedLeft`: when the failing operation's error was caught,
 * before any ROLLBACK. `serverDueAt`: earliest instant the transaction timer armed at BEGIN (possibly a stricter inherited
 * value) can have fired. `firedAt`: when the original-deadline watchdog fired. Times are performance.now() values.
 */
export interface TerminalEvidence { readonly at: number; readonly left: number; readonly state?: string }
export interface RunnerContext {
  readonly terminal?: TerminalEvidence; readonly failedAt?: number; readonly failedLeft?: number;
  readonly serverDueAt?: number; readonly firedAt?: number;
}
interface Cause { readonly error?: unknown; readonly state?: string; readonly at: number; readonly left: number }
/**
 * FIRST-cause classification. The cause is the first session terminal event when it was observed before the caught failure
 * (on equal times a structured event wins over a codeless failure), otherwise the caught failure; a later secondary error
 * never overrides it. Structured fields and the runner's own timers only; messages are never parsed or echoed.
 */
export function runnerFailure(error: unknown, budget: Budget, context: RunnerContext = {}): PowerOfficeErrorCode {
  const failedAt = context.failedAt ?? performance.now();
  const failed: Cause = { error, state: structuredState(error), at: failedAt, left: context.failedLeft ?? budget.left() };
  const t = context.terminal;
  const first = t !== undefined && (t.at < failedAt || (t.at === failedAt && t.state !== undefined && failed.state === undefined))
    ? { state: t.state, at: t.at, left: t.left } : failed;
  return classifyCause(first, context);
}
function classifyCause(cause: Cause, context: RunnerContext): PowerOfficeErrorCode {
  const error = cause.error;
  if (typeof error === 'object' && error !== null && budgetMarkers.has(error)) return 'POWEROFFICE_CLEANUP_TIMEOUT'; // row 1
  if (error instanceof AtlasError && PASSED.has(error.code)) return error.code as PowerOfficeErrorCode; // row 2
  // row 3: explicit Prisma fixed codes (P1xxx/P2xxx; PostgreSQL's own P-class is P0xxx, so they never collide)
  const e = error as { name?: unknown; code?: unknown; errorCode?: unknown } | null | undefined;
  if (TIMEOUT_CODES.has(e?.code) || TIMEOUT_CODES.has(e?.errorCode)) return 'POWEROFFICE_CLEANUP_TIMEOUT';
  if (e?.code === 'P2034') return 'POWEROFFICE_DB_CONFLICT';
  if (e?.name === 'PrismaClientInitializationError') return INIT_TIMEOUT_CODES.has(e.errorCode) ? 'POWEROFFICE_CLEANUP_TIMEOUT' : 'POWEROFFICE_RUNTIME_NOT_READY';
  if (cause.state !== undefined) { // rows 4–6: a positively known SQLSTATE is never relabelled by any clock
    if (TIMEOUT_STATES.has(cause.state)) return 'POWEROFFICE_CLEANUP_TIMEOUT';
    if (cause.state === '40P01' || cause.state === '40001') return 'POWEROFFICE_DB_CONFLICT';
    return 'POWEROFFICE_CLEANUP_FAILED';
  }
  // rows 7–10: codeless — inferred only from the runner's own timers at the time the cause was OBSERVED
  if (context.firedAt !== undefined && cause.at >= context.firedAt) return 'POWEROFFICE_CLEANUP_TIMEOUT';
  if (context.serverDueAt !== undefined && cause.at >= context.serverDueAt) return 'POWEROFFICE_CLEANUP_TIMEOUT';
  if (cause.left <= ANCHOR_RESERVE_MS) return 'POWEROFFICE_CLEANUP_TIMEOUT';
  return 'POWEROFFICE_CLEANUP_FAILED';
}
/** A connection that never became usable: a known SQLSTATE decides; codeless after our own timer/window → timeout; else readiness. */
export function connectFailure(error: unknown, timedOut: boolean, left: number): PowerOfficeErrorCode {
  const state = structuredState(error);
  if (state !== undefined) return TIMEOUT_STATES.has(state) ? 'POWEROFFICE_CLEANUP_TIMEOUT' : 'POWEROFFICE_RUNTIME_NOT_READY';
  if (timedOut || left <= ANCHOR_RESERVE_MS) return 'POWEROFFICE_CLEANUP_TIMEOUT';
  return 'POWEROFFICE_RUNTIME_NOT_READY';
}
/** One query on the runner's single connection: rows of a parameterized statement. */
export type RunnerQuery = <R>(sql: string, ...params: unknown[]) => Promise<R[]>;
/** The statement helper handed to the body: re-bounds statement_timeout to the remaining budget before each statement. */
export interface Bounded { statement(): Promise<void>; check(): void }

/** Paired-URL options this transport keeps: Prisma's `schema` (search_path) and `connect_timeout` (seconds). */
function urlOptions(url: string): { schema: string; connectTimeoutMs: number } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema') ?? 'public';
  const raw = u.searchParams.get('connect_timeout');
  const seconds = raw === null ? DEFAULT_CONNECT_TIMEOUT_S : /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema) || !Number.isFinite(seconds)) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
  return { schema, connectTimeoutMs: seconds === 0 ? Infinity : seconds * 1000 };
}

interface PgClient {
  connect(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; end(): Promise<void>; on(event: string, listener: (e: unknown) => void): unknown;
  readonly host: string; readonly port: number; readonly processID: number | null; readonly secretKey: number | null;
  readonly connection: { readonly stream: { destroy(): void } };
}
async function pgClient(url: string, connectionTimeoutMillis: number): Promise<PgClient> {
  let pg: { Client: new (config: object) => PgClient };
  try { pg = (await import('pg')).default as unknown as typeof pg; } catch { throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY'); }
  return new pg.Client({ connectionString: url, connectionTimeoutMillis });
}

/** current_setting() text of a millisecond-based GUC (e.g. "0", "1500ms", "30s", "2min") → milliseconds; null if unknown form. */
export function settingMs(text: unknown): number | null {
  const m = typeof text === 'string' ? /^([0-9]{1,10})(ms|s|min|h|d)?$/.exec(text) : null;
  if (!m) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * unit[m[2] ?? 'ms']!;
}

/**
 * The deadline watchdog (S4C-rc3 F1): armed with the original budget BEFORE connect. At the deadline it marks the run
 * expired and, while any client operation is in flight, sends this backend's protocol CancelRequest (runner-cancel.ts) —
 * or, before the server issued its cancel key (connect/login), closes the socket. If the operation still has not settled
 * after CANCEL_GRACE_MS the socket is destroyed. The awaited operation therefore always settles from the server's own
 * cancellation (or socket loss); the client never returns while its statement is still running by choice.
 */
export const CANCEL_GRACE_MS = 2_000;
interface Watchdog { expired(): boolean; firedAt(): number | undefined; track<T>(operation: Promise<T>): Promise<T>; stop(): void }
function watchdog(client: PgClient, budget: Budget): Watchdog {
  let inFlight = 0; let fired = false; let firedAt: number | undefined; let backstop: ReturnType<typeof setTimeout> | undefined;
  const destroy = () => { try { client.connection.stream.destroy(); } catch { /* already closed */ } };
  const timer = setTimeout(() => {
    fired = true; firedAt = performance.now();
    if (inFlight === 0) return;
    if (client.processID !== null && client.secretKey !== null) {
      void sendCancelRequest({ host: client.host, port: Number(client.port), processID: client.processID, secretKey: client.secretKey }, CANCEL_GRACE_MS);
    } else destroy();
    backstop = setTimeout(() => { if (inFlight > 0) destroy(); }, CANCEL_GRACE_MS);
  }, Math.max(0, budget.left()));
  return {
    expired: () => fired || budget.left() < 1,
    firedAt: () => firedAt,
    async track<T>(operation: Promise<T>): Promise<T> {
      inFlight++;
      // An operation started after the deadline (e.g. ROLLBACK) may not hang either: it gets the same socket backstop.
      const late = fired ? setTimeout(() => { if (inFlight > 0) destroy(); }, CANCEL_GRACE_MS) : undefined;
      try { return await operation; } finally { inFlight--; if (late) clearTimeout(late); }
    },
    stop: () => { clearTimeout(timer); if (backstop) clearTimeout(backstop); },
  };
}

/**
 * One runner transaction on `url` under `budget`. `body` runs inside it and must call `bounded.statement()` before each of
 * its statements. Throws the fixed failure code; returns only after the database outcome is settled.
 */
export async function runBoundedTransaction<T>(url: string, budget: Budget, body: (query: RunnerQuery, bounded: Bounded) => Promise<T>): Promise<T> {
  if (budget.left() < 1) spent();
  const options = urlOptions(url);
  const connectMs = Math.max(1, Math.min(budget.left(), options.connectTimeoutMs));
  const client = await pgClient(url, connectMs);
  // The FIRST terminal event of the session — its time, budget left and SQLSTATE when structured — kept for classification
  // only; later events never replace it.
  let terminal: TerminalEvidence | undefined;
  client.on('error', (error: unknown) => { terminal ??= { at: performance.now(), left: budget.left(), state: structuredState(error) }; });
  const guard = watchdog(client, budget);
  const query: RunnerQuery = async <R>(sql: string, ...params: unknown[]) => (await guard.track(client.query(sql, params))).rows as R[];
  const started = performance.now();
  try { await guard.track(client.connect()); } catch (error) {
    guard.stop();
    await client.end().catch(() => undefined);
    throw powerOfficeError(connectFailure(error, guard.expired() || performance.now() - started >= connectMs - 1, budget.left()));
  }
  let open = false;
  let serverDueAt: number | undefined; // earliest instant the transaction timer armed at BEGIN can have fired (client clock)
  try {
    const check = () => { if (guard.expired() || budget.left() < 1) spent(); };
    // P2: relation-free read of the inherited values (no catalog relation, no lock); bounded by the watchdog.
    const [row] = await query<{ t: string; s: string; l: string }>(`SELECT current_setting('transaction_timeout') AS t,
      current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`);
    const inherited = { transaction_timeout: settingMs(row?.t), statement_timeout: settingMs(row?.s), lock_timeout: settingMs(row?.l) };
    if (Object.values(inherited).some(v => v === null)) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
    const stricter = (name: keyof typeof inherited, ours: number) => { const v = inherited[name]!; return v > 0 && v < ours ? v : ours; };
    // P3: session settings BEFORE BEGIN on this very connection; then BEGIN arms the server timer with exactly this value. An
    // inherited (role/database/user/startup) value is honored only when it is STRICTER; it never extends either bound.
    const computed = performance.now();
    check();
    const remaining = budget.left() - ANCHOR_RESERVE_MS;
    if (remaining < 1) spent();
    const ms = stricter('transaction_timeout', remaining);
    const statementMs = stricter('statement_timeout', Math.min(ms, CLEANUP_BUDGET_MS));
    const lockMs = stricter('lock_timeout', CLEANUP_LOCK_TIMEOUT_MS);
    await query(`SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false), set_config('transaction_timeout', $3, false),
      set_config('search_path', $4, false)`, `${statementMs}ms`, `${lockMs}ms`, `${ms}ms`, options.schema);
    // From here every setup statement also has the server's statement_timeout / lock_timeout.
    const effective = await query<{ name: string; setting: string; source: string }>(`SELECT name, setting, source FROM pg_catalog.pg_settings
      WHERE name IN ('transaction_timeout', 'statement_timeout', 'lock_timeout') ORDER BY name`);
    const expected: Record<string, string> = { lock_timeout: String(lockMs), statement_timeout: String(statementMs), transaction_timeout: String(ms) };
    if (effective.length !== 3 || effective.some(r => r.setting !== expected[r.name] || r.source !== 'session')) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
    check();
    const beginSent = performance.now();
    await guard.track(client.query('BEGIN'));
    open = true;
    serverDueAt = beginSent + ms;
    if (performance.now() - computed > ANCHOR_RESERVE_MS) spent(); // the server timer could otherwise end after the deadline
    const bounded: Bounded = {
      check,
      async statement() {
        check();
        await query(`SELECT set_config('statement_timeout', $1, true)`, `${Math.max(1, Math.min(budget.left(), statementMs))}ms`);
        check();
      },
    };
    const result = await body(query, bounded);
    check(); // pre-COMMIT; COMMIT itself stays under the server-side transaction timer armed at BEGIN
    await guard.track(client.query('COMMIT'));
    open = false;
    return result;
  } catch (error) {
    // Evidence is fixed BEFORE the ROLLBACK attempt; ROLLBACK/close errors are never evidence.
    const context: RunnerContext = { terminal, failedAt: performance.now(), failedLeft: budget.left(), serverDueAt, firedAt: guard.firedAt() };
    if (open) await guard.track(client.query('ROLLBACK')).catch(() => undefined);
    throw powerOfficeError(runnerFailure(error, budget, context));
  } finally {
    guard.stop();
    await client.end().catch(() => undefined);
  }
}
