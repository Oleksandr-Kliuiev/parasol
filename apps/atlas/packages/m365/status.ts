/**
 * Read-side status semantics of the stored M365 state (docs/stage2/03_CONNECTOR_SYNC.md §3, 02 §3/§5), pure functions over
 * owner- or runtime-read rows. Directory: no success yet → MISSING; a pointer within freshness and no newer attempt → OK;
 * older than 60m or a newer pending/failed attempt → STALE (last good data, DIRECTORY_STALE); payload expired → MISSING
 * (DIRECTORY_EXPIRED); failures without retained good data → ERROR. Sign-in roots keep traversal coverage and freshness
 * apart: a fully traversed root stays COMPLETE when its retrieval is older than 15m, only its freshness becomes STALE.
 * The full correlation query/cursor contract (02 §5) is S2-C.
 */
export const DIRECTORY_FRESH_MS = 60 * 60_000;
export const SIGNIN_FRESH_MS = 15 * 60_000;

export interface DirectoryStateRow {
  status: string; safeErrorCode: string | null; activeGenerationId: string | null; latestStartedSeq: number; latestPublishedSeq: number;
  /** Charged claims since the last publication or reset (migration 202610081400). */
  attemptsUsed?: number;
}
/** reasonCodes gains M365_ATTEMPTS_EXHAUSTED when the retry budget is spent (an explicit reset is then required). */
export interface DirectoryView { status: 'OK' | 'STALE' | 'MISSING' | 'ERROR'; reasonCodes: string[]; attemptsUsed: number; maxAttempts: number }
export const DIRECTORY_MAX_ATTEMPTS = 8;
export function directoryView(state: DirectoryStateRow | null, generation: { completedAt: Date; expiresAt: Date } | null, now: Date): DirectoryView {
  const attemptsUsed = Number(state?.attemptsUsed ?? 0);
  const budget = { attemptsUsed, maxAttempts: DIRECTORY_MAX_ATTEMPTS };
  const exhausted = attemptsUsed >= DIRECTORY_MAX_ATTEMPTS ? ['M365_ATTEMPTS_EXHAUSTED'] : [];
  if (!state) return { status: 'MISSING', reasonCodes: [], ...budget };
  if (!state.activeGenerationId || !generation) {
    if (state.status === 'ERROR') return { status: 'ERROR', reasonCodes: [state.safeErrorCode ?? 'M365_SYNC_FAILED', ...exhausted], ...budget };
    return { status: 'MISSING', reasonCodes: [...(state.safeErrorCode ? [state.safeErrorCode] : []), ...exhausted], ...budget };
  }
  if (now.getTime() >= generation.expiresAt.getTime()) return { status: 'MISSING', reasonCodes: ['DIRECTORY_EXPIRED', ...exhausted], ...budget };
  const newerAttempt = Number(state.latestStartedSeq) > Number(state.latestPublishedSeq);
  if (newerAttempt || now.getTime() - generation.completedAt.getTime() >= DIRECTORY_FRESH_MS) {
    return { status: 'STALE', reasonCodes: ['DIRECTORY_STALE', ...(state.status === 'ERROR' && state.safeErrorCode ? [state.safeErrorCode] : []), ...exhausted], ...budget };
  }
  return { status: 'OK', reasonCodes: exhausted, ...budget };
}

export interface WindowRow { rootFrom: Date; rootTo: Date; latestStartedSeq: number; latestPublishedSeq: number; status: string; safeErrorCode: string | null }
export interface PublishedAttemptRow { coveredFrom: Date; coveredTo: Date; publishedAt: Date; expiresAt: Date }
export interface RootCoverage {
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'; freshness: 'FRESH' | 'STALE' | null;
  gaps: { from: Date; to: Date }[]; retrievedAt: Date | null; reasonCodes: string[];
}
/** Coverage of one root clipped to [from, to) (default: the whole root) from exactly its published attempt. */
export function rootCoverage(window: WindowRow, attempt: PublishedAttemptRow | null, now: Date, from: Date = window.rootFrom, to: Date = window.rootTo): RootCoverage {
  const codes = window.status === 'ERROR' && window.safeErrorCode ? [window.safeErrorCode] : [];
  if (!attempt || now.getTime() >= attempt.expiresAt.getTime()) {
    return { coverage: 'UNAVAILABLE', freshness: null, gaps: [{ from, to }], retrievedAt: null, reasonCodes: codes };
  }
  const gaps: { from: Date; to: Date }[] = [];
  if (attempt.coveredFrom > from) gaps.push({ from, to: new Date(Math.min(attempt.coveredFrom.getTime(), to.getTime())) });
  if (attempt.coveredTo < to) gaps.push({ from: new Date(Math.max(attempt.coveredTo.getTime(), from.getTime())), to });
  const stale = Number(window.latestStartedSeq) > Number(window.latestPublishedSeq) || now.getTime() - attempt.publishedAt.getTime() >= SIGNIN_FRESH_MS;
  return { coverage: gaps.length === 0 ? 'COMPLETE' : 'PARTIAL', freshness: stale ? 'STALE' : 'FRESH', gaps, retrievedAt: attempt.publishedAt, reasonCodes: codes };
}
