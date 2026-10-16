import type { DecisionConfig } from './provider.ts';

/**
 * Circuit breaker and call budget for an external decision provider (task 1.7, docs/04). One guard per worker process and
 * provider, shared by the advisory path and the shadow jobs.
 *   CLOSED → `failureThreshold` consecutive failures → OPEN for `openMs` → one probe call (HALF_OPEN): an answer closes the
 *   circuit, a failure opens it again; a probe that never reports back expires after `openMs`. A refusal is an answer
 *   from a working provider, not an outage.
 *   Budget: at most `maxProviderCallsPerMinute` admitted calls in any 60-second window.
 * A refused admission is explicit, never a silent fallback: advisory switches the event to the rules baseline with
 * PROVIDER_CIRCUIT_OPEN or PROVIDER_BUDGET_EXHAUSTED among its reasons; a shadow job is SKIPPED with that code. No call is made.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type Refusal = 'PROVIDER_CIRCUIT_OPEN' | 'PROVIDER_BUDGET_EXHAUSTED';
export type Admission = { allowed: true } | { allowed: false; reason: Refusal };
export interface GuardSnapshot { state: CircuitState; consecutiveFailures: number; openUntil: string | null; callsInWindow: number; timesOpened: number }

const WINDOW_MS = 60_000;
const ANSWERS = new Set(['DECISION_REFUSED']);

export class DecisionGuard {
  #state: CircuitState = 'CLOSED';
  #failures = 0;
  #openUntil = 0;
  #probeStartedAt: number | null = null;
  #calls: number[] = [];
  #timesOpened = 0;
  readonly #limits: Pick<DecisionConfig, 'budget' | 'circuitBreaker'>;
  readonly #now: () => number;
  constructor(limits: Pick<DecisionConfig, 'budget' | 'circuitBreaker'>, now: () => number = Date.now) {
    this.#limits = limits; this.#now = now;
  }

  /** Asks to make one provider call now. An allowed call must report its outcome with `record`. */
  admit(): Admission {
    const now = this.#now();
    if (this.#state === 'OPEN') {
      if (now < this.#openUntil) return { allowed: false, reason: 'PROVIDER_CIRCUIT_OPEN' };
      this.#state = 'HALF_OPEN'; this.#probeStartedAt = null;
    }
    if (this.#state === 'HALF_OPEN' && this.#probeStartedAt !== null && now - this.#probeStartedAt < this.#limits.circuitBreaker.openMs) {
      return { allowed: false, reason: 'PROVIDER_CIRCUIT_OPEN' }; // one probe at a time
    }
    this.#calls = this.#calls.filter(t => now - t < WINDOW_MS);
    if (this.#calls.length >= this.#limits.budget.maxProviderCallsPerMinute) return { allowed: false, reason: 'PROVIDER_BUDGET_EXHAUSTED' };
    this.#calls.push(now);
    if (this.#state === 'HALF_OPEN') this.#probeStartedAt = now;
    return { allowed: true };
  }

  /** Outcome of an admitted call: its safe error code, or null for an answer. */
  record(errorCode: string | null): void {
    if (errorCode === null || ANSWERS.has(errorCode)) {
      this.#failures = 0; this.#state = 'CLOSED'; this.#probeStartedAt = null;
      return;
    }
    this.#failures++;
    if (this.#state === 'HALF_OPEN' || this.#failures >= this.#limits.circuitBreaker.failureThreshold) {
      this.#state = 'OPEN'; this.#openUntil = this.#now() + this.#limits.circuitBreaker.openMs; this.#probeStartedAt = null; this.#timesOpened++;
    }
  }

  snapshot(): GuardSnapshot {
    const now = this.#now();
    return { state: this.#state, consecutiveFailures: this.#failures, openUntil: this.#state === 'OPEN' ? new Date(this.#openUntil).toISOString() : null,
      callsInWindow: this.#calls.filter(t => now - t < WINDOW_MS).length, timesOpened: this.#timesOpened };
  }
}
