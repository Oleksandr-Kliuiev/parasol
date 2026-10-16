import type { CorrelationCoverage, CorrelationResource, CoverageGap, CoverageWindow } from './contracts.ts';
import { CORRELATION_SOURCE_SCOPE } from './contracts.ts';
import { SIGNIN_FRESH_MS } from '../m365/status.ts';
import { hourFloorMs, keyOfDate, keyPlusMs, maxKey, minKey } from './time.ts';
import { transitionAt } from './cursor.ts';
import type { Transition } from './cursor.ts';
import type { DbClock, TimeKey } from './time.ts';

/**
 * Sign-in traversal coverage of an exact query interval (02 §5, 03 §3/§5), pure. Each nonoverlapping canonical UTC root
 * contributes exactly its currently published immutable attempt — state COMPLETE, publishedAt set, unexpired at the
 * snapshot clock — clipped to the query and to current retention (now − 7d). Coverage status is traversal only:
 * COMPLETE iff no gap, PARTIAL iff some coverage and a gap, UNAVAILABLE iff nothing usable. Freshness is independent: a
 * portion older than 15m, or of a root with a newer started attempt (pending/failed refresh), is STALE but keeps its
 * original retrieval time; gaps never contain time merely older than freshness. A deliberately unavailable sign-in
 * capability is MISSING + M365_SIGNINS_NOT_AVAILABLE with UNAVAILABLE coverage — never complete-empty data.
 * All bounds compare as fixed-width seven-digit keys; millisecond timestamps are converted before clipping.
 */
export const SIGNIN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const HOUR = 3_600_000;

export interface PublishedAttemptState { id: string; state: string; coveredFrom: Date; coveredTo: Date; publishedAt: Date | null; expiresAt: Date }
export interface RootState {
  windowId: string; rootFrom: Date; started: number; published: number; recorded: number; status: string; safeErrorCode: string | null;
  /** State of the attempt with the newest started sequence (null when it no longer exists). */
  latestState: string | null;
  attempt: PublishedAttemptState | null;
}
export interface SignInCapability { status: string; safeErrorCode: string | null }
export interface CoverageAssessment {
  coverage: CorrelationCoverage; resource: CorrelationResource;
  /** The published attempts whose clipped portion contributes: the only memberships an item may come from. */
  published: { windowId: string; attemptId: string }[];
  /** Seven-digit transitions at which freshness or retention of a contributing portion changes (cursor.ts decides future-ness). */
  transitions: Transition[];
  /** Every output-influencing mutable input (pointers, latest attempt states/sequences, capability); no clock value. */
  fingerprint: unknown;
}

const usable = (a: PublishedAttemptState | null, now: Date): a is PublishedAttemptState =>
  !!a && a.state === 'COMPLETE' && a.publishedAt !== null && a.expiresAt.getTime() > now.getTime();

function pushGap(gaps: CoverageGap[], fromInclusive: TimeKey, toExclusive: TimeKey, reasonCode: string): void {
  if (fromInclusive >= toExclusive) return;
  const last = gaps.at(-1);
  if (last && last.toExclusive === fromInclusive && last.reasonCode === reasonCode) last.toExclusive = toExclusive;
  else gaps.push({ fromInclusive, toExclusive, reasonCode });
}

export function assessCoverage(roots: readonly RootState[], capability: SignInCapability | null, from: TimeKey, to: TimeKey, clock: DbClock): CoverageAssessment {
  const assessedAt = clock.now.toISOString();
  const fingerprint = {
    capability: capability ? [capability.status, capability.safeErrorCode] : null,
    roots: roots.map(r => [r.windowId, r.rootFrom.getTime(), r.started, r.published, r.recorded, r.status, r.safeErrorCode, r.latestState,
      r.attempt ? [r.attempt.id, r.attempt.state, r.attempt.expiresAt.getTime()] : null]),
  };
  if (capability?.status === 'UNAVAILABLE') {
    return { published: [], transitions: [], fingerprint,
      coverage: { status: 'UNAVAILABLE', traversalComplete: false, completedWindows: [], gaps: [{ fromInclusive: from, toExclusive: to, reasonCode: 'M365_SIGNINS_NOT_AVAILABLE' }],
        sourceScope: CORRELATION_SOURCE_SCOPE, assessedAt, freshness: 'UNKNOWN' },
      resource: { resourceType: 'm365_signin', status: 'MISSING', lastSuccessAt: null, asOf: null, safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE', coverage: 'UNAVAILABLE' } };
  }
  const byRoot = new Map(roots.map(r => [r.rootFrom.getTime(), r]));
  const retentionFloor = keyPlusMs(clock.key, -SIGNIN_RETENTION_MS);
  const completedWindows: CoverageWindow[] = []; const gaps: CoverageGap[] = [];
  const published: { windowId: string; attemptId: string }[] = []; const transitions: Transition[] = [];
  let errorCode: string | null = null; let newest = 0; let oldest = Infinity;
  for (let h = hourFloorMs(from); keyOfDate(new Date(h)) < to; h += HOUR) {
    const segFrom = maxKey(keyOfDate(new Date(h)), from); const segTo = minKey(keyOfDate(new Date(h + HOUR)), to);
    const root = byRoot.get(h);
    if (root?.status === 'ERROR' && root.safeErrorCode) errorCode ??= root.safeErrorCode;
    const attempt = root?.attempt ?? null;
    if (!root || !usable(attempt, clock.now)) {
      pushGap(gaps, segFrom, segTo, !root ? 'M365_WINDOW_NOT_COLLECTED' : attempt?.publishedAt ? 'RETENTION_EXPIRED' : root.safeErrorCode ?? 'M365_WINDOW_NOT_PUBLISHED');
      continue;
    }
    const covered = keyOfDate(attempt.coveredFrom);
    const cFrom = maxKey(maxKey(covered, segFrom), retentionFloor); const cTo = minKey(keyOfDate(attempt.coveredTo), segTo);
    if (cFrom >= cTo) { pushGap(gaps, segFrom, segTo, retentionFloor >= segTo ? 'RETENTION_EXPIRED' : 'M365_WINDOW_NOT_COVERED'); continue; }
    pushGap(gaps, segFrom, cFrom, retentionFloor > maxKey(covered, segFrom) ? 'RETENTION_EXPIRED' : 'M365_WINDOW_NOT_COVERED');
    const publishedAt = attempt.publishedAt!;
    const stale = root.started > root.published || clock.now.getTime() - publishedAt.getTime() >= SIGNIN_FRESH_MS;
    completedWindows.push({ rootWindowId: root.windowId, publishedAttemptId: attempt.id, fromInclusive: cFrom, toExclusive: cTo,
      retrievedAt: publishedAt.toISOString(), freshness: stale ? 'STALE' : 'FRESH' });
    pushGap(gaps, cTo, segTo, 'M365_WINDOW_NOT_COVERED');
    published.push({ windowId: root.windowId, attemptId: attempt.id });
    // Attempt expiry and freshness hold AT their instant; the retention clip moves the portion only AFTER from + 7d.
    transitions.push(transitionAt(attempt.expiresAt), { at: keyPlusMs(maxKey(covered, segFrom), SIGNIN_RETENTION_MS), strict: true });
    if (!stale) transitions.push(transitionAt(new Date(publishedAt.getTime() + SIGNIN_FRESH_MS)));
    newest = Math.max(newest, publishedAt.getTime()); oldest = Math.min(oldest, publishedAt.getTime());
  }
  const fresh = completedWindows.filter(w => w.freshness === 'FRESH').length;
  const freshness = completedWindows.length === 0 ? 'UNKNOWN' : fresh === completedWindows.length ? 'FRESH' : fresh === 0 ? 'STALE' : 'MIXED';
  const status = completedWindows.length === 0 ? 'UNAVAILABLE' : gaps.length === 0 ? 'COMPLETE' : 'PARTIAL';
  const resource: CorrelationResource = completedWindows.length === 0
    ? { resourceType: 'm365_signin', status: errorCode ? 'ERROR' : 'MISSING', lastSuccessAt: null, asOf: null,
      safeErrorCode: errorCode ?? gaps[0]?.reasonCode ?? 'M365_WINDOW_NOT_COLLECTED', coverage: 'UNAVAILABLE' }
    : { resourceType: 'm365_signin', status: freshness === 'FRESH' ? 'OK' : 'STALE', lastSuccessAt: new Date(newest).toISOString(),
      asOf: new Date(oldest).toISOString(), safeErrorCode: freshness === 'FRESH' ? null : errorCode, coverage: status };
  return { published, transitions, fingerprint, resource,
    coverage: { status, traversalComplete: status === 'COMPLETE', completedWindows, gaps, sourceScope: CORRELATION_SOURCE_SCOPE, assessedAt, freshness } };
}
