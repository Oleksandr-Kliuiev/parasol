import { performance } from 'node:perf_hooks';
import type { Prisma } from '@prisma/client';
import { askFailure } from './contracts.ts';

/**
 * One private DB phase (docs/stage5/ask/03 "Resource budgets"): its end is fixed ONCE at phase start as
 * min(2 s, remaining original budget) and never reset per statement. The statement runner is the only way a phase talks to
 * PostgreSQL: before and after every ACTUAL awaited statement (also inside reused shared helpers) it checks the run (terminal
 * state, original deadline) and the phase end, and re-bounds the transaction-local statement_timeout to the time LEFT in the
 * phase, so successive lock waits share one budget. After the phase stops (deadline or caller-visible failure) no further statement starts; rollback and
 * cleanup stay with the driver and are still awaited by the owner (authority.ts).
 */
export interface PhaseRun { check(): void }
export class AskPhase {
  readonly #run: PhaseRun;
  readonly #end: number;
  readonly #now: () => number;
  #stopped = false;
  constructor(run: PhaseRun, ms: number, now: () => number = () => performance.now()) {
    this.#run = run;
    this.#now = now;
    this.#end = now() + ms;
  }
  /** Whole milliseconds left in this phase (never more than at its start). */
  remaining(): number { return Math.max(0, Math.floor(this.#end - this.#now())); }
  stop(): void { this.#stopped = true; }
  get stopped(): boolean { return this.#stopped; }
  /** Terminal run → AskStopped; original deadline, phase end or a stopped phase → ASK_DEADLINE. */
  check(): void {
    this.#run.check();
    if (this.#stopped || this.#now() >= this.#end) askFailure('ASK_DEADLINE');
  }
}

const SET_TIMEOUT = `SELECT set_config('statement_timeout', $1, true)`;
const RAW_METHODS: ReadonlySet<string> = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe']);

/**
 * rc3 (R2a): the Ask-only guarded view of the phase's transaction. EVERY actual statement — raw calls and model-delegate
 * calls, including each of the separately awaited statements inside the accepted shared helpers (currentToken, setLocal),
 * which are reused unmodified — passes the boundary: run/phase check before it starts, statement_timeout re-bounded to the
 * time LEFT in the phase, and a run/phase check after its await returns. A terminal or expired run therefore starts no new
 * statement at any internal await; the transaction then rolls back, which also discards transaction-local settings.
 */
function guardedTransaction(tx: Prisma.TransactionClient, phase: AskPhase): Prisma.TransactionClient {
  const boundary = async <T>(start: () => PromiseLike<T>): Promise<T> => {
    phase.check();
    await tx.$executeRawUnsafe(SET_TIMEOUT, `${Math.max(1, phase.remaining())}ms`);
    phase.check();
    const value = await start();
    phase.check();
    return value;
  };
  const methods = (target: object) => new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      return typeof value === 'function' ? (...args: unknown[]) => boundary(() => Reflect.apply(value, object, args) as PromiseLike<unknown>) : value;
    }
  });
  return new Proxy(tx, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string') return value;
      if (RAW_METHODS.has(key) && typeof value === 'function') return (...args: unknown[]) => boundary(() => Reflect.apply(value, target, args) as PromiseLike<unknown>);
      if (!key.startsWith('$') && value !== null && typeof value === 'object') return methods(value);
      return value;
    }
  });
}

/** Runs ONE logical step of the phase's transaction through the guarded view, with checks around the whole step too. */
export interface PhaseSql {
  <T>(statement: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** The same boundary check for synchronous decisions between statements (charge, branch). */
  check(): void;
}
export function phaseSql(tx: Prisma.TransactionClient, phase: AskPhase): PhaseSql {
  const guarded = guardedTransaction(tx, phase);
  const run = async <T>(statement: (t: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    phase.check();
    const value = await statement(guarded);
    phase.check();
    return value;
  };
  return Object.assign(run, { check: () => phase.check() });
}
