import { CORPUS_FILES, FIXTURE_FILE, GROUPS, MATRIX, ORDER_SEED, readData, sha256, stableOrder } from './dataset.ts';
import type { EvalCase } from './dataset.ts';

// Artifact metadata and the safe offline receipt. Dataset/fixture FILE hashes are artifact identity (allowed); no
// per-question hash, length, text, payload, raw answer or observed intent is ever computed into or written to evidence.
// assertSafeReceipt re-scans the serialized receipt for every frozen question and for forbidden keys before output.

export function datasetManifest(cases: readonly EvalCase[], read: (name: string) => Buffer = readData): Record<string, unknown> {
  const files = CORPUS_FILES.map(name => { const bytes = read(name); return { name, sha256: sha256(bytes), cases: bytes.toString('utf8').split('\n').filter(Boolean).length }; });
  const fixture = read(FIXTURE_FILE);
  const { orderSha256 } = stableOrder(cases.map(c => c.caseId));
  const counts = Object.fromEntries(GROUPS.map(g => [g, { total: MATRIX[g].total, ru: MATRIX[g].ru, en: MATRIX[g].en }]));
  return { artifact: 'S5ASKREMOTE-REVAL-DATASET', version: 'reval-dataset-v1', labelStatus: 'DRAFT_MODEL_ASSISTED', attestation: 'HUMAN_ATTESTATION_PENDING',
    holdout: 'ALL_200', semanticEvaluation: false, caseCount: cases.length, counts, orderSeed: ORDER_SEED, orderSha256,
    files, fixtures: { name: FIXTURE_FILE, sha256: sha256(fixture) },
    corpusSha256: sha256(files.map(f => `${f.name}:${f.sha256}`).join('\n')) };
}

const FORBIDDEN_KEYS = ['question', 'questions', 'answer', 'payload', 'observedIntent', 'rawAnswer', 'providerContent', 'content', 'questionSha256', 'questionLength'];
export function receiptIssues(receipt: unknown, cases: readonly EvalCase[]): string[] {
  const text = JSON.stringify(receipt);
  const issues: string[] = [];
  for (const c of cases) if (text.includes(JSON.stringify(c.question).slice(1, -1))) issues.push(`QUESTION_TEXT:${c.caseId}`);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.includes(k)) issues.push(`FORBIDDEN_KEY:${k}`); walk(x); }
  };
  walk(receipt);
  return issues;
}
export function assertSafeReceipt(receipt: unknown, cases: readonly EvalCase[]): void {
  const issues = receiptIssues(receipt, cases);
  if (issues.length > 0) throw new Error(`UNSAFE_RECEIPT:${issues.slice(0, 5).join(',')}`);
}

/** Fixed list of what this offline package does NOT verify (kept in every receipt). */
export const UNVERIFIED = Object.freeze([
  'LIVE_PROVIDER_CLASSIFICATION_QUALITY', 'PROVIDER_LATENCY_AND_2S_BUDGET_ON_REAL_NETWORK', 'ACTUAL_RESPONSE_SHAPE_MODEL_TIER_USAGE', 'EU_PROJECT_REGION_RETENTION_ZDR',
  'DEDICATED_KEY_AND_ACCOUNT_ASSOCIATION', 'CURRENT_PRICE_CONTRACT', 'PLATFORM_EGRESS_ALLOWLIST', 'PRODUCTION_DB_AUTHORITY_FENCE_LEDGER_UNDER_THIS_PROCEDURE',
  'BROWSER_V2_JOURNEY_UNDER_THIS_PROCEDURE', 'PRIVACY_SCAN_OF_REAL_DESTINATIONS', 'LIVE_SUPERVISOR_IMPLEMENTATION', 'PREFLIGHT_FRESHNESS_WINDOW',
  'NETWORK_GUARD_OUTSIDE_MAIN_JS_REALM', 'HUMAN_LABEL_ATTESTATION', 'INDEPENDENT_SOL_OPUS_ACCEPTANCE'
]);
