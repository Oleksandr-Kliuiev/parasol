import { randomUUID } from 'node:crypto';
import { decodeSnapshot } from '../../packages/reval/payloads.ts';
import type { Snapshot } from '../../packages/reval/payloads.ts';

/**
 * TEST-ONLY builders for the R-EVAL instrument revision (RS-C-B): a controller SNAPSHOT payload that satisfies every relation of
 * the accepted decoder (periods/attempt sums, ordering, consistency) for a given set of synthetic attempts. Synthetic values only.
 */
export interface FakeAttempt { readonly correlationId: string; readonly state: 'EGRESS_COMMITTED' | 'SETTLED' | 'UNKNOWN'; readonly outcome: string | null; readonly accounted: string }
export function fakeSnapshot(o: { admissionId: string; policyVersion?: string; fixtureId?: string; now?: string; attempts?: readonly FakeAttempt[];
  policyState?: string; dayCap?: string; monthCap?: string; fence?: string; expiresAt?: string } ): Snapshot {
  const now = o.now ?? '2026-10-12T10:00:00.000Z'; const day = now.slice(0, 10); const month = `${now.slice(0, 7)}-01`;
  const attempts = (o.attempts ?? []).map((a, i) => ({ attemptId: randomUUID(), correlationId: a.correlationId, admissionId: o.admissionId, policyVersion: o.policyVersion ?? '3',
    createdAt: new Date(Date.parse(now) - 60_000 + i * 1000).toISOString(), dayStart: day, monthStart: month, reservedMicroUsd: '300000',
    accountedMicroUsd: a.accounted, state: a.state, outcome: a.outcome, settledAt: a.state === 'EGRESS_COMMITTED' ? null : new Date(Date.parse(now) - 30_000 + i * 1000).toISOString() }));
  const charged = attempts.reduce((n, a) => n + BigInt(a.accountedMicroUsd), 0n).toString();
  const count = String(attempts.length);
  return decodeSnapshot({ snapshotId: randomUUID(), dbObservedAt: now, admissionId: o.admissionId, policyVersion: o.policyVersion ?? '3', fenceEpoch: o.fence ?? '7',
    policyState: o.policyState ?? 'ACTIVE', reserveMicroUsd: '300000', dayCapMicroUsd: o.dayCap ?? '2000000', monthCapMicroUsd: o.monthCap ?? '10000000',
    expiresAt: o.expiresAt ?? '2026-10-13T00:00:00.000Z', currentDay: day, currentMonth: month, fixtureGeneration: '1', fixtureId: o.fixtureId ?? 'FX07',
    projectAttemptCount: count, foreignScopeAttemptCount: '0', consistent: true, attempts,
    periods: [{ kind: 'MONTH', periodStart: month, chargedMicroUsd: charged, attemptCount: count }, { kind: 'DAY', periodStart: day, chargedMicroUsd: charged, attemptCount: count }] });
}
