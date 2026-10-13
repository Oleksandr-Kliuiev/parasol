// Owner decision D1 (rs-d/OWNER_DECISIONS.md; rs-d brief A §1): the executed order of ONE admitted run groups the frozen 200 cases by
// fixture — groups in the order of each fixture's first appearance in the frozen order, the frozen relative order inside a group — so
// a run needs 10 fixture switches instead of 177. No new randomness or choice: the rule is a pure function of the frozen order, and its
// result must equal the pinned digest. The frozen order (and its digest) stays the dataset identity; this is recorded separately.
import { createHash } from 'node:crypto';
import type { Corpus } from '../ask-remote-eval-execution/session.ts';

export const ORDER_RULE = 'FIXTURE_GROUPED_FIRST_APPEARANCE_V1';
/** sha256 of the grouped order's IDs joined by '\n' (FX07, FX05, FX10, FX02, FX03, FX09, FX11, FX04, FX01, FX08, FX06). */
export const GROUPED_ORDER_SHA256 = '0c8878f77997db635cfb5b124287cef3ecb4e7a55a427b534ff10032ffb7b152';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export interface ExecutedOrder { readonly rule: string; readonly sha256: string; readonly frozenOrderSha256: string }

/** The grouped permutation of `frozen` under `fixtureOf` (pure). */
export function groupedOrder(frozen: readonly string[], fixtureOf: (caseId: string) => string): string[] {
  const groups: string[] = [];
  for (const id of frozen) { const f = fixtureOf(id); if (!groups.includes(f)) groups.push(f); }
  return groups.flatMap(g => frozen.filter(id => fixtureOf(id) === g));
}

/** The bound corpus with the grouped order, refused (ORDER_DRIFT) unless the result has the pinned digest. */
export function withGroupedOrder(corpus: Corpus): { corpus: Corpus; order: ExecutedOrder } {
  const order = groupedOrder(corpus.order, id => corpus.cases.get(id)!.fixtureId);
  const digest = sha(order.join('\n'));
  if (digest !== GROUPED_ORDER_SHA256 || order.length !== corpus.order.length) throw Object.assign(new Error('ORDER_DRIFT'), { code: 'ORDER_DRIFT' });
  return { corpus: { ...corpus, order }, order: Object.freeze({ rule: ORDER_RULE, sha256: digest, frozenOrderSha256: sha(corpus.order.join('\n')) }) };
}
