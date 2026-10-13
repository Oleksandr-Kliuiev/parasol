import { performance } from 'node:perf_hooks';
import { ASK_LIMITS } from './contracts.ts';

/**
 * Local physical-work budget of ONE API process (docs/stage5/ask/03_SECURITY_AND_STATE.md "Resource budgets"):
 *   - ≤4 underlying Ask task owners in total, reserved synchronously at enabled ingress before any asynchronous work,
 *     including provisional owners that are still parsing or authenticating (both routes);
 *   - after authentication the SAME owner binds to its exact (workspaceId, actorId): ≤1 bound owner per actor, ≤64 tracked
 *     actor entries, never a release/reacquire gap;
 *   - 10 admitted questions per actor per rolling 60 s, charged only after positive phase1 authority, never refunded.
 * An owner is released exactly once, when its request flow has finished AND every underlying piece of work it holds
 * (transaction promise and callback, planner promise) has actually settled. A public timeout or disconnect never releases
 * it; a never-settling task keeps its slot until restart. No background worker, polling or eviction of active entries.
 * Monotonic clock. This bounds one process, not a distributed quota.
 */
export type BindOutcome = 'BOUND' | 'BUSY';
interface ActorEntry { readonly workspaceId: string; readonly actorId: string; owner: AskOwner | null; admissions: number[] }
/** Module-private binding of an owner to its actor entry: no property on the owner, set once by AskBudget. */
const bindings = new WeakMap<AskOwner, ActorEntry>();
interface OwnerOps {
  release(owner: AskOwner): void;
  bind(owner: AskOwner, workspaceId: string, actorId: string, rate: boolean): BindOutcome;
  charge(owner: AskOwner): boolean;
}

export class AskOwner {
  readonly #ops: OwnerOps;
  #holds = 1;
  #finished = false;
  #released = false;
  /** R-EVAL RS-C-A: observers of the actual physical release (terminal observation `physicalOwnerReleased`). */
  readonly #onRelease: (() => void)[] = [];
  constructor(ops: OwnerOps) { this.#ops = ops; }
  get released(): boolean { return this.#released; }
  /** Calls `fn` once when this owner is actually released (immediately if it already was). Observation only. */
  onRelease(fn: () => void): void { if (this.#released) fn(); else this.#onRelease.push(fn); }
  get bound(): boolean { return bindings.has(this); }
  /** Keeps the slot until `work` settles (either way). Ignored only after release, which no flow can reach while holding. */
  hold(work: Promise<unknown>): void {
    if (this.#released) return;
    this.#holds += 1;
    const drop = () => this.#drop();
    work.then(drop, drop);
  }
  /** The request flow is over (response published or never will be). Idempotent; the slot waits for held work. */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#drop();
  }
  /** Binds this owner to the authenticated actor; `rate` also refuses an actor whose rolling window is already full. */
  bind(workspaceId: string, actorId: string, rate: boolean): BindOutcome { return this.#ops.bind(this, workspaceId, actorId, rate); }
  /** One rolling admission after positive phase1 authority; false when the actor's window is full (429). */
  charge(): boolean { return this.#ops.charge(this); }
  #drop(): void {
    this.#holds -= 1;
    if (this.#holds > 0 || this.#released) return;
    this.#released = true;
    this.#ops.release(this);
    for (const fn of this.#onRelease.splice(0)) { try { fn(); } catch { /* observers never affect the budget */ } }
  }
}

export class AskBudget {
  readonly #now: () => number;
  readonly #actors = new Map<string, Map<string, ActorEntry>>();
  #entries = 0;
  #active = 0;
  #releases = 0;
  readonly #ops: OwnerOps;
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#ops = {
      release: owner => this.#release(owner),
      bind: (owner, workspaceId, actorId, rate) => this.#bind(owner, workspaceId, actorId, rate),
      charge: owner => this.#charge(owner)
    };
  }
  /** Counters for tests and fixed diagnostics only. */
  get active(): number { return this.#active; }
  get entries(): number { return this.#entries; }
  get releases(): number { return this.#releases; }
  admissions(workspaceId: string, actorId: string): number { return this.#actors.get(workspaceId)?.get(actorId)?.admissions.length ?? 0; }

  /** Synchronous provisional reservation at ingress; null means 429 before any body, authentication or DB work. */
  reserve(): AskOwner | null {
    if (this.#active >= ASK_LIMITS.globalOwners) return null;
    this.#active += 1;
    return new AskOwner(this.#ops);
  }

  #prune(entry: ActorEntry): void {
    const horizon = this.#now() - ASK_LIMITS.rollingWindowMs;
    while (entry.admissions.length > 0 && entry.admissions[0]! <= horizon) entry.admissions.shift();
  }
  #idleExpired(entry: ActorEntry): boolean { this.#prune(entry); return entry.owner === null && entry.admissions.length === 0; }
  #delete(workspaceId: string, actorId: string): void {
    const actors = this.#actors.get(workspaceId);
    if (actors?.delete(actorId)) this.#entries -= 1;
    if (actors && actors.size === 0) this.#actors.delete(workspaceId);
  }
  /** Removes only idle entries whose last admission is ≥60 s old; an active or draining entry is never evicted. */
  #pruneIdle(): void {
    for (const [workspaceId, actors] of [...this.#actors]) {
      for (const [actorId, entry] of [...actors]) if (this.#idleExpired(entry)) this.#delete(workspaceId, actorId);
    }
  }
  #bind(owner: AskOwner, workspaceId: string, actorId: string, rate: boolean): BindOutcome {
    if (owner.released || owner.bound) return 'BUSY';
    let entry = this.#actors.get(workspaceId)?.get(actorId);
    if (!entry) {
      if (this.#entries >= ASK_LIMITS.actorEntries) this.#pruneIdle();
      if (this.#entries >= ASK_LIMITS.actorEntries) return 'BUSY';
      entry = { workspaceId, actorId, owner: null, admissions: [] };
      let actors = this.#actors.get(workspaceId);
      if (!actors) { actors = new Map(); this.#actors.set(workspaceId, actors); }
      actors.set(actorId, entry);
      this.#entries += 1;
    }
    this.#prune(entry);
    const refused = entry.owner !== null || (rate && entry.admissions.length >= ASK_LIMITS.rollingQuestions);
    if (refused) {
      if (entry.owner === null && entry.admissions.length === 0) this.#delete(workspaceId, actorId);
      return 'BUSY';
    }
    entry.owner = owner;
    bindings.set(owner, entry);
    return 'BOUND';
  }
  #charge(owner: AskOwner): boolean {
    const entry = bindings.get(owner);
    if (!entry || entry.owner !== owner) return false;
    this.#prune(entry);
    if (entry.admissions.length >= ASK_LIMITS.rollingQuestions) return false;
    entry.admissions.push(this.#now());
    return true;
  }
  #release(owner: AskOwner): void {
    this.#active -= 1;
    this.#releases += 1;
    const entry = bindings.get(owner);
    if (!entry || entry.owner !== owner) return;
    entry.owner = null;
    // An entry that was never charged leaves immediately; a charged one stays until its window has passed.
    this.#prune(entry);
    if (entry.admissions.length === 0) this.#delete(entry.workspaceId, entry.actorId);
  }
}

/** The original monotonic deadline of one request, started at enabled ingress and never reset. */
export class AskDeadline {
  readonly #now: () => number;
  readonly #end: number;
  constructor(totalMs: number = ASK_LIMITS.deadlineMs, now: () => number = () => performance.now()) { this.#now = now; this.#end = now() + totalMs; }
  remaining(): number { return Math.max(0, this.#end - this.#now()); }
  expired(): boolean { return this.#now() >= this.#end; }
  /** Bound of one phase: min(phase cap, remaining original budget), whole milliseconds. */
  phase(capMs: number): number { return Math.floor(Math.min(capMs, this.remaining())); }
}
