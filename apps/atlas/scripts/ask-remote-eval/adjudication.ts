import { readFileSync } from 'node:fs';
import { INTENTS, parseJsonl } from './dataset.ts';
import type { EvalCase } from './dataset.ts';

// Human review / adjudication records (docs/stage5/ask/remote/eval/adjudication/). The committed templates are ALL PENDING
// with empty reviewer slots: no human has reviewed anything yet and nothing here may be filled by a model. The validator
// accepts only reviewerKind HUMAN with an opaque reviewer reference (no email/name), two DISTINCT reviewers for every
// refusal case, and blocks freeze while any label diverges from the draft or any case is unresolved.

export const ADJUDICATION_DIR = new URL('../../docs/stage5/ask/remote/eval/adjudication/', import.meta.url);
export const REFUSAL_TEMPLATE = 'refusal-dual-review.jsonl';
export const SUPPORTED_TEMPLATE = 'supported-review.jsonl';
export const readAdjudication = (name: string): string => readFileSync(new URL(name, ADJUDICATION_DIR), 'utf8');

const emptyReview = () => ({ reviewerKind: null, reviewerRef: null, label: null, basis: null, reviewedAt: null });
export function refusalTemplate(cases: readonly EvalCase[]): string {
  return cases.filter(c => c.expectedIntent === 'UNSUPPORTED').map(c => JSON.stringify({ caseId: c.caseId, draftLabel: c.expectedIntent,
    reviewerA: emptyReview(), reviewerB: emptyReview(), adjudication: null, status: 'PENDING' })).join('\n') + '\n';
}
export function supportedTemplate(cases: readonly EvalCase[]): string {
  return cases.filter(c => c.expectedIntent !== 'UNSUPPORTED').map(c => JSON.stringify({ caseId: c.caseId, draftLabel: c.expectedIntent,
    reviewer: emptyReview(), fixturePredicatesReviewed: null, status: 'PENDING' })).join('\n') + '\n';
}

type Review = { reviewerKind: unknown; reviewerRef: unknown; label: unknown; basis: unknown; reviewedAt: unknown };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isEmpty = (r: Review): boolean => [r.reviewerKind, r.reviewerRef, r.label, r.basis, r.reviewedAt].every(v => v === null);
function reviewIssues(r: unknown, where: string): string[] {
  if (r === null || typeof r !== 'object') return [`${where}_SHAPE`];
  const v = r as Review;
  if (Object.keys(v).sort().join() !== 'basis,label,reviewedAt,reviewerKind,reviewerRef') return [`${where}_KEYS`];
  if (isEmpty(v)) return [];
  const issues: string[] = [];
  if (v.reviewerKind !== 'HUMAN') issues.push(`${where}_NOT_HUMAN`);
  if (typeof v.reviewerRef !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(v.reviewerRef)) issues.push(`${where}_REVIEWER_REF`);
  if (!(INTENTS as readonly unknown[]).includes(v.label)) issues.push(`${where}_LABEL`);
  if (typeof v.basis !== 'string' || v.basis.length < 3) issues.push(`${where}_BASIS`);
  if (typeof v.reviewedAt !== 'string' || !ISO.test(v.reviewedAt)) issues.push(`${where}_TIME`);
  return issues;
}

export interface AdjudicationState { readonly issues: readonly string[]; readonly resolved: number; readonly total: number; readonly humanAttestationComplete: boolean }
/** Refusal dual review: PENDING | AGREED (two distinct humans, same label) | ADJUDICATED (human final decision). */
export function validateRefusalReview(text: string, cases: readonly EvalCase[]): AdjudicationState {
  const rows = parseJsonl(text) as Record<string, unknown>[];
  const refusal = cases.filter(c => c.expectedIntent === 'UNSUPPORTED');
  const issues: string[] = [];
  if (rows.map(r => r.caseId).join() !== refusal.map(c => c.caseId).join()) issues.push('CASE_SET');
  let resolved = 0;
  rows.forEach(row => {
    const id = String(row.caseId);
    if (Object.keys(row).sort().join() !== 'adjudication,caseId,draftLabel,reviewerA,reviewerB,status') { issues.push(`${id}:KEYS`); return; }
    if (row.draftLabel !== 'UNSUPPORTED') issues.push(`${id}:DRAFT_LABEL`);
    const a = row.reviewerA as Review; const b = row.reviewerB as Review;
    issues.push(...reviewIssues(a, 'A').map(x => `${id}:${x}`), ...reviewIssues(b, 'B').map(x => `${id}:${x}`));
    const bothFilled = a && b && !isEmpty(a) && !isEmpty(b);
    if (bothFilled && a.reviewerRef === b.reviewerRef) issues.push(`${id}:SAME_REVIEWER`);
    if (row.status === 'PENDING') return;
    if (!bothFilled) { issues.push(`${id}:RESOLVED_WITHOUT_TWO_REVIEWS`); return; }
    let final: unknown = null;
    if (row.status === 'AGREED') {
      if (a.label !== b.label || row.adjudication !== null) issues.push(`${id}:AGREED_MISMATCH`);
      final = a.label;
    } else if (row.status === 'ADJUDICATED') {
      const adj = row.adjudication as Record<string, unknown> | null;
      if (!adj || adj.reviewerKind !== 'HUMAN' || typeof adj.reviewerRef !== 'string' || !(INTENTS as readonly unknown[]).includes(adj.finalLabel)
        || typeof adj.decidedAt !== 'string' || !ISO.test(adj.decidedAt)) issues.push(`${id}:ADJUDICATION_INVALID`);
      final = adj?.finalLabel;
    } else { issues.push(`${id}:STATUS`); return; }
    if (final !== row.draftLabel) issues.push(`${id}:LABEL_DIVERGES_FROM_DRAFT`);
    resolved += 1;
  });
  return { issues, resolved, total: refusal.length, humanAttestationComplete: issues.length === 0 && resolved === refusal.length };
}

/** Supported single-human review of the label and the fixture predicates of its case. */
export function validateSupportedReview(text: string, cases: readonly EvalCase[]): AdjudicationState {
  const rows = parseJsonl(text) as Record<string, unknown>[];
  const supported = cases.filter(c => c.expectedIntent !== 'UNSUPPORTED');
  const issues: string[] = [];
  if (rows.map(r => r.caseId).join() !== supported.map(c => c.caseId).join()) issues.push('CASE_SET');
  let resolved = 0;
  rows.forEach((row, i) => {
    const id = String(row.caseId);
    if (Object.keys(row).sort().join() !== 'caseId,draftLabel,fixturePredicatesReviewed,reviewer,status') { issues.push(`${id}:KEYS`); return; }
    if (row.draftLabel !== supported[i]?.expectedIntent) issues.push(`${id}:DRAFT_LABEL`);
    issues.push(...reviewIssues(row.reviewer, 'R').map(x => `${id}:${x}`));
    if (row.status === 'PENDING') return;
    const r = row.reviewer as Review;
    if (row.status !== 'REVIEWED' || isEmpty(r) || row.fixturePredicatesReviewed !== true) { issues.push(`${id}:RESOLVED_INVALID`); return; }
    if (r.label !== row.draftLabel) issues.push(`${id}:LABEL_DIVERGES_FROM_DRAFT`);
    resolved += 1;
  });
  return { issues, resolved, total: supported.length, humanAttestationComplete: issues.length === 0 && resolved === supported.length };
}
