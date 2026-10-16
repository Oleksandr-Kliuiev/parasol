// DB observation queue selection (docs/stage5/02_CONTRACTS.md, Observation defaults). DOM-free. The selection is built
// only from known enum values and offered page sizes; anything else is refused locally and never sent. Fixture contexts
// have no selection at all: their queue is the fixed demo page (GET with no query).
import { ACTIVE_OBSERVATION_STATUSES, OBSERVATION_STATUSES, QUEUE_PAGE_SIZES, SEVERITIES } from './contracts.ts';
import type { ObservationStatus, QueuePageSize, QueuePosition, QueueQuery, Severity } from './contracts.ts';

export const DEFAULT_QUEUE_QUERY: QueueQuery = Object.freeze({
  statuses: Object.freeze([...ACTIVE_OBSERVATION_STATUSES]), severities: Object.freeze([...SEVERITIES]), limit: QUEUE_PAGE_SIZES[0]
});
export const FIRST_PAGE: QueuePosition = Object.freeze({ cursor: null, number: 1 });

/** Canonical non-empty subset of `allowed` without repeats, or null when `values` is empty or has anything unknown/repeated. */
function subset<T extends string>(values: readonly unknown[], allowed: readonly T[]): T[] | null {
  if (values.length === 0 || values.length > allowed.length || new Set(values).size !== values.length) return null;
  if (!values.every(v => typeof v === 'string' && (allowed as readonly string[]).includes(v))) return null;
  return allowed.filter(a => values.includes(a));
}

/** A queue selection from operator input, or null (refused locally: no request is made). */
export function queueQuery(statuses: readonly unknown[], severities: readonly unknown[], limit: unknown): QueueQuery | null {
  const s = subset<ObservationStatus>(statuses, OBSERVATION_STATUSES);
  const v = subset<Severity>(severities, SEVERITIES);
  if (!s || !v || !(QUEUE_PAGE_SIZES as readonly unknown[]).includes(limit)) return null;
  return Object.freeze({ statuses: Object.freeze(s), severities: Object.freeze(v), limit: limit as QueuePageSize });
}
