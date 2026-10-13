// Counters and ledger metadata from the controller's measured SNAPSHOT (rs-c brief B §3): the accepted RC5 session takes them as
// its `counters` (before submit) and `outcome.ledger` (after the case) inputs instead of operator-typed values. The mapping of the
// accepted R-B attempt vocabulary to the RC5 settlement vocabulary is fixed here; nothing is inferred beyond it.
import { decodeSnapshot } from '../../packages/reval/payloads.ts';
import type { Snapshot } from '../../packages/reval/payloads.ts';
import type { CountersInput, LedgerInput } from '../ask-remote-eval-execution/validate.ts';

export { decodeSnapshot };
export type { Snapshot };
const RESERVE = '300000';
/** DAY/MONTH accounted micro-USD of the snapshot's own current UTC day/month (0 when no counter row exists yet). */
export function countersOf(s: Snapshot): CountersInput {
  const charged = (kind: 'DAY' | 'MONTH', start: string) => s.periods.find(p => p.kind === kind && p.periodStart === start)?.chargedMicroUsd ?? '0';
  return { dayChargedMicro: charged('DAY', s.currentDay), monthChargedMicro: charged('MONTH', s.currentMonth) };
}
/**
 * The attempts bound to `correlationId` (accepted R-B outcomes → RC5 settlements):
 * none → NO_RESERVATION; SETTLED USAGE_VERIFIED → CONFIRMED (charged = accounted); SETTLED NO_DISPATCH → NO_DISPATCH (0);
 * MODEL_MISMATCH / USAGE_INVALID / UPSTREAM_REJECTED → RETAINED_KNOWN (reserve); DELIVERY_UNKNOWN → RETAINED_UNKNOWN_COMMIT
 * (reserve); a still EGRESS_COMMITTED attempt is 'PENDING' (the caller re-reads within its bound, then treats it as unknown).
 */
export function ledgerOf(s: Snapshot, correlationId: string, pendingAsUnknown = false): LedgerInput | 'PENDING' {
  const mine = s.attempts.filter(a => a.correlationId === correlationId);
  const counters = countersOf(s);
  const base = { correlationId, attempts: String(mine.length), ...counters };
  if (mine.length === 0) return { ...base, settlement: 'NO_RESERVATION', chargedMicro: '0' };
  const last = [...mine].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0).at(-1)!;
  if (last.state === 'EGRESS_COMMITTED') return pendingAsUnknown ? { ...base, settlement: 'RETAINED_UNKNOWN_COMMIT', chargedMicro: RESERVE } : 'PENDING';
  if (last.state === 'SETTLED' && last.outcome === 'USAGE_VERIFIED') return { ...base, settlement: 'CONFIRMED', chargedMicro: last.accountedMicroUsd };
  if (last.state === 'SETTLED' && last.outcome === 'NO_DISPATCH') return { ...base, settlement: 'NO_DISPATCH', chargedMicro: '0' };
  if (last.outcome === 'MODEL_MISMATCH' || last.outcome === 'USAGE_INVALID' || last.outcome === 'UPSTREAM_REJECTED') return { ...base, settlement: 'RETAINED_KNOWN', chargedMicro: RESERVE };
  return { ...base, settlement: 'RETAINED_UNKNOWN_COMMIT', chargedMicro: RESERVE };
}
