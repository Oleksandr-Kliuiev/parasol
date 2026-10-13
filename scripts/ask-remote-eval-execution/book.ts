// Conservative local liability book of ONE run (attested numbers; not a server ledger). It keeps the accounted DAY/MONTH
// floors this session has already seen (pre-submit counters and reconciled post-settlement counters) so a later counter read
// can never silently erase a known charge or retained reserve: MONTH never resets inside the single admitted month, DAY
// resets only when the actual UTC day bucket advances. It also checks that a reply kind and its ledger metadata can both be
// true: a validated remote answer or an upstream-implying error needs EXACTLY one dispatched attempt with a dispatched
// settlement state. No refund is ever invented: anything contradictory becomes an UNKNOWN commit for the caller.
import { utcDay, utcMonth } from '../ask-remote-eval/supervisor.ts';
import type { Ledger } from './validate.ts';

/** Reply classes whose existence implies the request reached the provider and a reserve was taken. */
export type ReplyClass = 'ANSWER' | 'UPSTREAM_INVALID' | 'UPSTREAM_MODEL_OR_USAGE' | 'OTHER';
export const replyClassOf = (kind: 'ANSWER' | 'ERROR' | 'NONE', code: string | null): ReplyClass =>
  kind === 'ANSWER' ? 'ANSWER' : code === 'ASK_REMOTE_INVALID' ? 'UPSTREAM_INVALID'
    : code === 'ASK_REMOTE_MODEL_MISMATCH' || code === 'ASK_REMOTE_USAGE_INVALID' ? 'UPSTREAM_MODEL_OR_USAGE' : 'OTHER';

/** Can this reply and this ledger metadata both be true? (RUNBOOK §15: answer → usage cost or retained reserve;
 * invalid with validated usage → cost; model/tier/usage mismatch → whole reserve.) */
export function ledgerMatchesReply(reply: ReplyClass, l: Ledger): boolean {
  if (reply === 'OTHER') return l.attempts <= 1;
  if (l.attempts !== 1) return false;
  const retained = l.settlement === 'RETAINED_KNOWN' || l.settlement === 'RETAINED_UNKNOWN_COMMIT';
  if (reply === 'UPSTREAM_MODEL_OR_USAGE') return retained;
  return retained || (l.settlement === 'CONFIRMED' && l.chargedMicro >= 1);
}

export type CounterCheck = 'OK' | 'COUNTERS_BELOW_ACCOUNTED_FLOOR' | 'CLOCK_REGRESSION' | 'MONTH_BUCKET_CHANGED';
export interface Totals { readonly confirmedChargedMicro: number; readonly retainedReserveMicro: number; readonly unknownLiabilityCases: number }

export class LiabilityBook {
  #day: number | null = null; #dayMicro = 0; #month: number | null = null; #monthMicro = 0;
  #confirmed = 0; #retained = 0; #unknown = 0;

  /** Pre-submit counters at `utcMs`: never below an accounted floor of the same bucket. Accepted values raise the floor. */
  checkCounters(utcMs: number, c: { dayChargedMicro: number; monthChargedMicro: number }): CounterCheck {
    const d = utcDay(utcMs); const m = utcMonth(utcMs);
    if (this.#month !== null && m !== this.#month) return 'MONTH_BUCKET_CHANGED';
    if (this.#day !== null && d < this.#day) return 'CLOCK_REGRESSION';
    if (c.monthChargedMicro < this.#monthMicro || (d === this.#day && c.dayChargedMicro < this.#dayMicro)) return 'COUNTERS_BELOW_ACCOUNTED_FLOOR';
    this.#raise(d, m, c.dayChargedMicro, c.monthChargedMicro);
    return 'OK';
  }
  #raise(d: number, m: number, day: number, month: number): void {
    if (this.#day !== d) { this.#day = d; this.#dayMicro = 0; }
    this.#month = m; this.#dayMicro = Math.max(this.#dayMicro, day); this.#monthMicro = Math.max(this.#monthMicro, month);
  }
  /** A reconciled attempt (pre + charged = post in the submission bucket) raises the floors and the totals. */
  reconciled(utcMs: number, l: Ledger): void {
    this.#raise(utcDay(utcMs), utcMonth(utcMs), l.dayChargedMicro, l.monthChargedMicro);
    if (l.settlement === 'CONFIRMED') this.#confirmed += l.chargedMicro;
    else if (l.settlement === 'RETAINED_KNOWN' || l.settlement === 'RETAINED_UNKNOWN_COMMIT') this.#retained += l.chargedMicro;
  }
  /** An attempt whose liability is not established by reconciled metadata (reserve presumed retained, amount unknown). */
  unknown(): void { this.#unknown += 1; }
  get totals(): Totals { return { confirmedChargedMicro: this.#confirmed, retainedReserveMicro: this.#retained, unknownLiabilityCases: this.#unknown }; }
}
