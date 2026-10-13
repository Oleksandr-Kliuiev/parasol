// Safe execution receipt: built ONLY from fixed enums, bounded integers, booleans, validated UUIDs/decimals and hashes;
// then re-validated against an exact allowlist schema (every key, type, enum and pattern) AND the accepted offline scan
// (no frozen question text, no forbidden key). Any mismatch throws RECEIPT_UNSAFE without detail. Question, rationale,
// labels, pasted bodies, raw answer and observed intent never reach this module. Validated numeric ledger/counter values,
// submission/closure versions and fences ARE kept (allowlisted), so the saved arithmetic can be replayed (replay.ts).
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_ERROR_CODES, ASK_REMOTE_ERROR_CODES } from '../../apps/operator/src/ask-contracts.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import { receiptIssues } from '../ask-remote-eval/evidence.ts';
import { PREDICATE_VERSION } from '../ask-remote-eval/predicates.ts';
import { admissionBlockers, ADMIN_PATHS } from './artifact.ts';
import { replayNumeric } from './replay.ts';
import { LOCAL_REASONS, SAFETY } from './session.ts';
import { HANDOFF_DETAILS } from './transient.ts';
import type { ExecutionSession, RunClass, SafetyRow } from './session.ts';
import { CASE_ID, reject, SETTLEMENTS, SHA256, UUID_V4 } from './validate.ts';

export const RECEIPT_SCHEMA = 'reval-execution-receipt-v2';
export const UNVERIFIED = Object.freeze(['LIVE_PROVIDER_CLASSIFICATION_QUALITY', 'PROVIDER_2S_BUDGET_TIMING', 'UPSTREAM_MODEL_TIER_USAGE_OBSERVATION',
  'EU_PROJECT_REGION_RETENTION', 'KEY_ACCOUNT_ASSOCIATION', 'CURRENT_PRICE_CONTRACT', 'PLATFORM_EGRESS_ALLOWLIST', 'SERVER_PROCESS_BUILD_IDENTITY',
  'SYNTHETIC_DB_EQUALS_FROZEN_FIXTURES', 'LEDGER_AND_COUNTERS_BEYOND_ATTESTATION', 'CLOSURE_RECEIPT_BEYOND_ATTESTATION', 'PUBLICATION_UNDER_CURRENT_AUTHORITY',
  'PASTED_TRANSIENT_EQUALS_SERVER_BYTES', 'OPERATOR_IDENTITY', 'PRIVACY_SCAN_BEFORE_AFTER', 'LIVE_PER_CASE_REPLAY', 'HUMAN_LABEL_ATTESTATION',
  'INDEPENDENT_SOL_OPUS_ACCEPTANCE_OF_EXECUTION_ARTIFACT', 'LOCAL_WALL_CLOCK_VS_SERVER_UTC', 'CAPABILITY_FRESHNESS_BEYOND_UNSEEN_CORRELATION',
  'BROWSER_FETCHES_OUTSIDE_REPORTED_PACING']);
/** The first two are conditional; every other blocker is unconditional in this tool version and must be present. */
const BLOCKERS = ['ARTIFACT_IDENTITY_NOT_VERIFIED', 'HUMAN_LABEL_ATTESTATION_PENDING', 'OWNER_DATA_BUDGET_ADMISSION_ABSENT', 'EXECUTION_ARTIFACT_ACCEPTANCE_PENDING',
  'LEDGER_METADATA_READ_CONTRACT_MISSING', 'CLOSURE_RECEIPT_READ_CONTRACT_MISSING', 'FIXTURE_DB_PROVISIONING_CONTRACT_MISSING', 'TRANSIENT_RESPONSE_HANDOFF_CONTRACT_MISSING',
  'SERVER_PROCESS_IDENTITY_UNVERIFIED', 'EGRESS_PLATFORM_PROOF_ABSENT', 'PRIVACY_SCAN_NOT_MEASURED', 'OPERATOR_IDENTITY_ATTESTED_ONLY'];
const REASONS = ['ADMISSION_EXPIRED', 'MONTH_CAP', 'DAY_CAP_NO_RESUME_WINDOW', 'DAY_CAP', 'LOSS_OF_AUTHORITY_INACTIVE_POLICY', 'THRESHOLD_UNREACHABLE', 'SAFETY_VIOLATION',
  'UNAUTHORIZED_PUBLICATION', 'LOSS_OF_AUTHORITY_WITHHELD', 'ASK_REMOTE_INVALID', 'ASK_REMOTE_MODEL_MISMATCH', 'ASK_REMOTE_USAGE_INVALID', 'UNAVAILABLE_CONFIG_FAULT',
  'UNAVAILABLE', 'UNKNOWN_COMMIT', 'LOSS_OF_AUTHORITY', 'UNCLASSIFIED_ERROR', 'UNKNOWN_SETTLEMENT_COMMIT', 'ALL_CASES_CONSUMED', 'DUPLICATE_DISPATCH', 'ARTIFACT_DRIFT'];
const OUTCOMES = ['ANSWER', 'WITHHELD_AUTHORITY_LOST', 'SUPERVISOR_TIMEOUT', 'SUBMITTED_TEXT_DEVIATION', ...ASK_ERROR_CODES, ...ASK_REMOTE_ERROR_CODES,
  'LOCAL_HANDOFF_UNVERIFIED', 'LEDGER_REPLY_CONTRADICTION', 'ABANDONED_IN_FLIGHT', 'UNRECORDED_CLICK', 'ANSWER_LIABILITY_UNKNOWN'];
const EVIDENCE: Readonly<Record<RunClass, Readonly<Record<SafetyRow, string>>>> = {
  UNADMITTED_LOCAL_OBSERVATION: { SCHEMA: 'ACCEPTED_VALIDATOR_ON_OPERATOR_PASTE_POTENTIAL_ENFORCEMENT', MODEL_TIER: 'PUBLIC_ENUM_ONLY_POTENTIAL_ENFORCEMENT',
    USAGE: 'PUBLIC_ENUM_ONLY_POTENTIAL_ENFORCEMENT', AUTHORITY: 'UNKNOWN_NO_PUBLICATION_AUTHORITY_READ', EGRESS: 'UNKNOWN_NO_PLATFORM_PROOF', PRIVACY: 'PENDING_NOT_MEASURED',
    CLAIMS: 'LOCAL_COMPARATOR_ON_OPERATOR_PASTE', COVERAGE: 'LOCAL_COMPARATOR_ON_OPERATOR_PASTE', URGENCY: 'LOCAL_COMPARATOR_ON_OPERATOR_PASTE',
    CONFIG: 'PUBLIC_ENUM_PLUS_ATTESTATION' },
  OFFLINE_FAKE_V2_REHEARSAL: { SCHEMA: 'LOCAL_COMPARATOR_ON_SIMULATED_FAKE_V2', MODEL_TIER: 'SIMULATED_FAKE_V2_ENUM', USAGE: 'SIMULATED_FAKE_V2_ENUM',
    AUTHORITY: 'NOT_MEASURED_IN_REHEARSAL', EGRESS: 'NOT_MEASURED_IN_REHEARSAL', PRIVACY: 'NOT_MEASURED_IN_REHEARSAL', CLAIMS: 'LOCAL_COMPARATOR_ON_SIMULATED_FAKE_V2',
    COVERAGE: 'LOCAL_COMPARATOR_ON_SIMULATED_FAKE_V2', URGENCY: 'LOCAL_COMPARATOR_ON_SIMULATED_FAKE_V2', CONFIG: 'SIMULATED_FAKE_V2_ENUM' }
};
const PROVENANCE: Readonly<Record<RunClass, Record<string, string>>> = {
  UNADMITTED_LOCAL_OBSERVATION: { operatorIdentity: 'ATTESTED_UNVERIFIED', admission: 'OPERATOR_ENTERED_ATTESTED', consent: 'OPERATOR_TTY_CHALLENGE_ATTESTED',
    transient: 'OPERATOR_PASTED_TRANSIENT', counters: 'OPERATOR_ENTERED_ATTESTED', ledger: 'OPERATOR_ENTERED_ATTESTED', closure: 'OPERATOR_ENTERED_ATTESTED',
    latency: 'OPERATOR_KEYSTROKE_BRACKETED_MONOTONIC_INTEGER_MS', utcClock: 'LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED', pacing: 'REPORTED_EVENTS_ONLY',
    correlationFreshness: 'UNSEEN_IN_SESSION_ONLY_NOT_SERVER_BOUND' },
  OFFLINE_FAKE_V2_REHEARSAL: { operatorIdentity: 'NOT_APPLICABLE_SIMULATED', admission: 'SIMULATED', consent: 'SCRIPTED_SIMULATED', transient: 'SIMULATED_FAKE_V2',
    counters: 'SIMULATED_FAKE_LEDGER', ledger: 'SIMULATED_FAKE_LEDGER', closure: 'SIMULATED_FAKE_LEDGER', latency: 'SIMULATED_INJECTED_MONOTONIC_INTEGER_MS', utcClock: 'SIMULATED_INJECTED_UTC',
    pacing: 'REPORTED_EVENTS_ONLY', correlationFreshness: 'UNSEEN_IN_SESSION_ONLY_NOT_SERVER_BOUND' }
};

/** Safe receipt of a session (validated before it is returned). */
export function buildReceipt(s: ExecutionSession, cases: readonly EvalCase[]): Record<string, unknown> {
  const f = s.facts(); const r = f.report as Record<string, any>; const id = s.start.identity!; const a = s.admission;
  const records: Record<string, unknown>[] = (r.records as Record<string, unknown>[]).map(rec => {
    const e = f.evidence.get(rec.caseId as string)!;
    return { caseId: rec.caseId, attempt: rec.attempt, outcome: e.localOutcome === 'ABANDONED_IN_FLIGHT' ? 'ABANDONED_IN_FLIGHT' : rec.outcome, localOutcome: e.localOutcome,
      semantic: e.semantic ?? rec.semantic, casePass: rec.casePass, verifiedPass: false, durationMs: rec.durationMs, censored: rec.censored, liability: rec.liability,
      correlationId: e.correlationId, submittedPolicyVersion: e.submittedPolicyVersion, utcDay: e.utcDay, preDayMicro: e.preDayMicro, preMonthMicro: e.preMonthMicro,
      ledger: e.ledger, ledgerAttempts: e.ledgerAttempts, ledgerSettlement: e.ledgerSettlement, chargedMicro: e.chargedMicro, postDayMicro: e.postDayMicro,
      postMonthMicro: e.postMonthMicro, reconciliation: e.reconciliation, text: e.text, reply: e.reply, handoffDetail: e.handoffDetail, truth: e.truth,
      configFaultAttested: e.configFaultAttested };
  });
  for (const x of f.extra) records.push({ caseId: x.caseId, attempt: 1, outcome: x.outcome, localOutcome: x.outcome, semantic: 'NOT_APPLICABLE', casePass: false,
    verifiedPass: false, durationMs: null, censored: true, liability: 'UNKNOWN', correlationId: null, submittedPolicyVersion: null, utcDay: null, preDayMicro: null,
    preMonthMicro: null, ledger: 'MISSING', ledgerAttempts: null, ledgerSettlement: null, chargedMicro: null, postDayMicro: null, postMonthMicro: null,
    reconciliation: 'UNKNOWN', text: 'REQUEST_UNVERIFIED', reply: 'NOT_OBSERVED', handoffDetail: null, truth: null, configFaultAttested: false });
  const receipt: Record<string, any> = {
    schema: RECEIPT_SCHEMA, runClass: s.runClass, liveAcceptanceEligible: false, liveAdmissionReadiness: 'BLOCKED', verifiedPass: false,
    admissionBlockers: admissionBlockers(s.start), provenance: PROVENANCE[s.runClass],
    artifact: { ...id, adminDeltaPaths: [...s.start.adminDeltaPaths], filesChecked: s.start.filesChecked, preSubmitChecks: f.preSubmitChecks,
      comparatorVersion: PREDICATE_VERSION, labelStatus: s.start.labelStatus, attestation: s.start.attestation },
    admission: { admissionId: a.admissionId, startUtcMs: a.startUtcMs, expiryUtcMs: a.expiryUtcMs, dayCapMicro: a.dayCapMicro, monthCapMicro: a.monthCapMicro,
      reserveMicro: a.reserveMicro, pacingMax: a.pacingMax, pacingWindowMs: a.pacingWindowMs, openingFenceEpoch: a.openingFenceEpoch, manualRerunAllowance: a.manualRerunAllowance },
    run: { state: f.state, supervisorState: r.state, reason: r.reason, localReason: f.localReason, closure: f.closure, voluntary: f.voluntary,
      voluntaryPauses: f.voluntaryPauses, consumed: r.consumed + f.extra.length, total: r.total, validatedAnswers: r.validatedAnswers,
      integrityViolations: f.integrity.length, integrityReasons: [...f.integrity], supportedPass: r.supportedPass, refusalPass: r.refusalPass,
      procedureThresholdsMet: f.thresholdsMet, verifiedPass: false, inFlight: f.inFlight && { ...f.inFlight, liability: 'UNKNOWN' }, handoffFailures: f.handoffFailures },
    liability: { ...f.totals },
    closures: f.closureHistory.map(c => ({ ...c })),
    latency: { percentileRule: 'NEAREST_RANK_CEIL', ...r.latency },
    safety: { comparedAnswers: f.compared, unattributedHandoffFailures: f.handoffFailures, rows: Object.fromEntries(SAFETY.map(row => [row, {
      violationsObserved: f.safety.get(row)!, evidence: EVIDENCE[s.runClass][row], countsAsVerifiedZero: false }])) },
    replay: { comparatorVersion: PREDICATE_VERSION, comparatorSha256: id.comparatorSha256, projectionSha256: id.projectionSha256,
      livePerCase: s.runClass === 'UNADMITTED_LOCAL_OBSERVATION' ? 'UNVERIFIABLE_UNDER_PRIVACY_CONTRACT' : 'SEE_REHEARSAL_REPLAY', numeric: 'PENDING' },
    cases: records, unverified: [...UNVERIFIED]
  };
  receipt.replay.numeric = replayNumeric(receipt).status;
  assertReceipt(receipt, cases);
  return receipt;
}

type V = (v: unknown) => boolean;
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const obj = (spec: Record<string, V>): V => v => plain(v) && Object.keys(v).join() === Object.keys(spec).join() && Object.entries(spec).every(([k, f]) => f(v[k]));
const map = (keys: readonly string[], item: V): V => v => plain(v) && Object.keys(v).join() === keys.join() && keys.every(k => item(v[k]));
const arr = (item: V, max: number): V => v => Array.isArray(v) && v.length <= max && v.every(item);
const set = (allowed: readonly string[]): V => v => Array.isArray(v) && new Set(v).size === v.length && v.every(x => allowed.includes(x as string));
const en = (...vals: unknown[]): V => v => vals.includes(v);
const oneOf = (vals: readonly unknown[]): V => v => vals.includes(v);
const int = (max = Number.MAX_SAFE_INTEGER): V => v => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const nul = (f: V): V => v => v === null || f(v);
const re = (p: RegExp): V => v => typeof v === 'string' && p.test(v);
const bool: V = v => typeof v === 'boolean';
const sha = re(SHA256); const dec = re(/^[1-9][0-9]{0,18}$/);
const lat = obj({ n: int(200), p50: nul(int()), p95: nul(int()), max: nul(int()) });
const STATES = ['ACTIVE', 'RESUMABLE_DAY', 'TERMINAL_INCOMPLETE', 'TERMINAL_FAILED', 'COMPLETE_PENDING_REVIEW'];
const CLOSURES = ['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'CONTAINMENT_UNCONFIRMED'];
const GROUPS = ['SUPPORTED_SUMMARY', 'SUPPORTED_WHY_URGENT', 'SUPPORTED_SOURCE_STATE', 'SUPPORTED_ENTITY'];
const evidenceValues = [...new Set(Object.values(EVIDENCE).flatMap(e => Object.values(e)))];
const provenanceValues = (k: string): V => oneOf(Object.values(PROVENANCE).map(p => p[k]));
const RECEIPT: V = obj({
  schema: en(RECEIPT_SCHEMA), runClass: en('OFFLINE_FAKE_V2_REHEARSAL', 'UNADMITTED_LOCAL_OBSERVATION'), liveAcceptanceEligible: en(false),
  liveAdmissionReadiness: en('BLOCKED'), verifiedPass: en(false), admissionBlockers: v => set(BLOCKERS)(v) && BLOCKERS.slice(2).every(b => (v as string[]).includes(b)),
  provenance: obj(Object.fromEntries(Object.keys(PROVENANCE.UNADMITTED_LOCAL_OBSERVATION).map(k => [k, provenanceValues(k)]))),
  artifact: obj({ offlinePackageHash: sha, offlineManifestSha256: sha, rcPackageHash: sha, rcManifestSha256: sha, datasetCorpusSha256: sha, fixtureSha256: sha,
    orderSha256: sha, orderSeed: en('S5ASKREMOTE-REVAL-ORDER-v1'), executionToolSha256: sha, comparatorSha256: sha, browserValidatorSha256: sha, projectionSha256: sha,
    adminOverlaySha256: sha, adminDeltaPaths: set(ADMIN_PATHS), filesChecked: int(100_000), preSubmitChecks: int(10_000), comparatorVersion: en(PREDICATE_VERSION),
    labelStatus: en('DRAFT_MODEL_ASSISTED'), attestation: en('HUMAN_ATTESTATION_PENDING') }),
  admission: obj({ admissionId: re(UUID_V4), startUtcMs: int(), expiryUtcMs: int(), dayCapMicro: int(), monthCapMicro: int(), reserveMicro: en(300_000),
    pacingMax: int(10), pacingWindowMs: en(60_000), openingFenceEpoch: dec, manualRerunAllowance: en(0) }),
  run: obj({ state: oneOf(STATES), supervisorState: oneOf(STATES), reason: nul(oneOf(REASONS)), localReason: nul(oneOf(LOCAL_REASONS)), closure: oneOf(CLOSURES),
    voluntary: oneOf(CLOSURES.map(c => c === 'NOT_REQUIRED' ? 'NONE' : c)), voluntaryPauses: int(1000), consumed: int(200), total: en(200), validatedAnswers: int(200),
    integrityViolations: int(1000), integrityReasons: arr(en('DUPLICATE_SUBMISSION', 'DUPLICATE_DISPATCH', 'ARTIFACT_DRIFT', 'UNRECORDED_CLICK'), 1000),
    supportedPass: map(GROUPS, int(25)), refusalPass: int(100), procedureThresholdsMet: bool, verifiedPass: en(false),
    inFlight: nul(obj({ caseId: re(CASE_ID), submittedPolicyVersion: dec, liability: en('UNKNOWN') })), handoffFailures: int(200) }),
  liability: obj({ confirmedChargedMicro: int(), retainedReserveMicro: int(), unknownLiabilityCases: int(200) }),
  closures: arr(obj({ seq: int(1000), kind: en('VOLUNTARY', 'DAY', 'TERMINAL'), result: en('CONFIRMED', 'CONTAINMENT_UNCONFIRMED'), policyVersion: nul(dec),
    fenceEpoch: nul(dec) }), 1000),
  latency: obj({ percentileRule: en('NEAREST_RANK_CEIL'), answered: lat, errorResponses: lat, censored: int(200), denominator: en(200) }),
  safety: obj({ comparedAnswers: int(200), unattributedHandoffFailures: int(200),
    rows: map(SAFETY, obj({ violationsObserved: int(200), evidence: oneOf(evidenceValues), countsAsVerifiedZero: en(false) })) }),
  replay: obj({ comparatorVersion: en(PREDICATE_VERSION), comparatorSha256: sha, projectionSha256: sha,
    livePerCase: en('UNVERIFIABLE_UNDER_PRIVACY_CONTRACT', 'SEE_REHEARSAL_REPLAY'), numeric: en('VERIFIED_SAVED_ARITHMETIC', 'MISMATCH') }),
  cases: arr(obj({ caseId: re(CASE_ID), attempt: en(1), outcome: oneOf(OUTCOMES), localOutcome: nul(oneOf(LOCAL_REASONS)),
    semantic: en('MATCH', 'MISMATCH', 'NOT_APPLICABLE'), casePass: bool, verifiedPass: en(false), durationMs: nul(int()), censored: bool,
    liability: oneOf([...SETTLEMENTS, 'UNKNOWN']), correlationId: nul(re(UUID_V4)), submittedPolicyVersion: nul(dec), utcDay: nul(int(1_000_000)),
    preDayMicro: nul(int()), preMonthMicro: nul(int()), ledger: en('BOUND', 'MISSING', 'UNBOUND', 'CONTRADICTS_REPLY'), ledgerAttempts: nul(int(200)),
    ledgerSettlement: nul(oneOf(SETTLEMENTS)), chargedMicro: nul(int(300_000)), postDayMicro: nul(int()), postMonthMicro: nul(int()),
    reconciliation: en('RECONCILED', 'UNRECONCILED', 'UNKNOWN'), text: en('REQUEST_MATCHED', 'REQUEST_DEVIATION', 'OPERATOR_REPORTED_DEVIATION', 'REQUEST_UNVERIFIED'),
    reply: en('V2_ANSWER_VALID', 'ERROR_ENVELOPE_VALID', 'LOCAL_HANDOFF_UNVERIFIED', 'TIMEOUT', 'ABANDONED', 'NOT_OBSERVED'), handoffDetail: nul(oneOf(HANDOFF_DETAILS)),
    truth: nul(obj({ claims: bool, coverage: bool, urgency: bool, schema: bool })), configFaultAttested: bool }), 200),
  unverified: v => JSON.stringify(v) === JSON.stringify(UNVERIFIED)
});

/** Exact allowlist schema + accepted scan (question texts, forbidden keys) + rationale texts. Throws RECEIPT_UNSAFE only. */
export function assertReceipt(receipt: unknown, cases: readonly EvalCase[]): void {
  const text = JSON.stringify(receipt);
  const rationaleLeak = cases.some(c => c.rationale.length >= 12 && text.includes(JSON.stringify(c.rationale).slice(1, -1)));
  if (!RECEIPT(receipt) || receiptIssues(receipt, cases).length > 0 || rationaleLeak) reject('RECEIPT_UNSAFE');
}

/** Exclusive per-admission run lock in the operator-chosen receipt directory: a second session for it cannot start. */
export function lockRun(dir: string, admissionId: string): void {
  if (!UUID_V4.test(admissionId)) reject('ADMISSION_ID_INVALID');
  try { closeSync(openSync(join(dir, `REVAL_EXECUTION_${admissionId}.lock`), 'wx', 0o600)); } catch { reject('RUN_ALREADY_STARTED_OR_DIR_UNWRITABLE'); }
}
/** Validated receipt → temp file (exclusive, fsync) → atomic rename; on failure the previous safe receipt stays intact.
 * Only this safe JSON is ever written. */
export function writeReceipt(dir: string, receipt: Record<string, unknown>, cases: readonly EvalCase[], name: string): string {
  assertReceipt(receipt, cases);
  if (!/^[A-Z0-9_.-]{1,80}\.json$/i.test(name)) reject('RECEIPT_NAME_INVALID');
  const target = join(dir, name); const temp = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
  } catch { try { rmSync(temp, { force: true }); } catch { /* the previous receipt stays intact */ } reject('RECEIPT_WRITE_FAILED'); }
  return target;
}
