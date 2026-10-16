// Receipt v6 of the instrument revision (rs-c brief B §6; rs-d briefs A §6, B §2.5): the ACCEPTED RC5 v2 receipt, exact and unchanged,
// as `base`, plus the measured part. v4 (RS-D-A) added the per-case PRE/POST process-census records and verdict, the DRAINs taken and
// the executed order (owner decision D1; a census failure makes `effective` at least TERMINAL_INCOMPLETE, CENSUS_UNVERIFIED); v5
// (RS-D-B) adds `proofs`: the exact PLATFORM_PROOF and PRIVACY_PROOF C produced, recorded only — they never upgrade a flag; v6 (RS-D-C)
// adds `build`: C's registered build digest from its one IDENTITY per run, which every recorded platform proof must carry. No base flag
// is ever upgraded (verifiedPass/liveAcceptanceEligible stay false, readiness BLOCKED); `provenance`
// supersedes base.provenance field by field for the measured inputs; `effective` may only make the run state STRICTER (06 failure
// precedence, rc2 F2: any authenticated terminal fault is FAILED whatever the handoff; an invalid record or a case without
// FINAL coverage is at least INCOMPLETE). Exact allowlist (rc2 F5) + the accepted offline scan; validated before every write;
// fsync + atomic rename + directory fsync (the previous safe receipt survives a failed write; macOS: F_FULLFSYNC via libuv, measured).
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDrain } from '../../packages/reval/census-payloads.ts';
import { decodePlatformProof, decodePrivacyProof } from '../../packages/reval/proof-payloads.ts';
import { decodeHandoffSummary } from '../../packages/reval/eval-transient.ts';
import { decodeTerminalObservation } from '../../packages/reval/eval-wire.ts';
import { isFailureCode } from '../../packages/reval/codes.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import { receiptIssues } from '../ask-remote-eval/evidence.ts';
import { assertReceipt, buildReceipt } from '../ask-remote-eval-execution/receipt.ts';
import type { ExecutionSession } from '../ask-remote-eval-execution/session.ts';
import { reject } from '../ask-remote-eval-execution/validate.ts';
import { CANDIDATE_ID } from './candidate.ts';
import { CENSUS_REASONS, CENSUS_RECORD_KEYS, CENSUS_VERDICTS } from './census.ts';
import type { RevisionRecord } from './identity.ts';
import { GROUPED_ORDER_SHA256, ORDER_RULE } from './order.ts';
import { ARM_STOPS } from './run.ts';
import type { CaseMeasure, MeasuredRun } from './run.ts';
import { CREDIT_BLOCKS } from './terminal.ts';

export const RECEIPT_V6 = 'reval-instrument-receipt-v6';
export const PROVENANCE_V6 = Object.freeze({ census: 'SERVER_GUARD_CENSUS_VIA_CONTROLLER', drain: 'CONTROLLER_COMPOSED_DRAIN',
  proofs: 'CONTROLLER_LOCAL_EVIDENCE_ADAPTERS', build: 'CONTROLLER_IDENTITY_BUILD_MANIFEST', transient: 'SERVER_BOUND_HANDOFF_COMMITTED_OR_UNVERIFIED', arrival: 'SERVER_TRANSFER_RECEIPT_MONOTONIC',
  counters: 'CONTROLLER_PRE_SNAPSHOT', ledger: 'CONTROLLER_POST_SNAPSHOT', capability: 'OPERATOR_PASTED_TRANSIENT', admission: 'OPERATOR_ENTERED_SNAPSHOT_CROSSCHECKED',
  consent: 'OPERATOR_TTY_CHALLENGE_ATTESTED', terminal: 'SERVER_OBSERVATION_VIA_CONTROLLER_JOURNAL', baseProvenance: 'SUPERSEDED_FIELD_BY_FIELD_BY_THIS_OBJECT' });
export const FLAGS_V6 = Object.freeze({ verifiedPass: false, liveAcceptanceEligible: false, liveAdmissionReadiness: 'BLOCKED' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RANK: Readonly<Record<string, number>> = { ACTIVE: 0, RESUMABLE_DAY: 1, COMPLETE_PENDING_REVIEW: 1, TERMINAL_INCOMPLETE: 2, TERMINAL_FAILED: 3 };
/** The fixed reasons of each stricter `effective` state. */
const EFFECTIVE_REASONS: Readonly<Record<string, readonly string[]>> = { TERMINAL_FAILED: ['AUTHENTICATED_TERMINAL_FAULT'],
  TERMINAL_INCOMPLETE: ['TERMINAL_OBSERVATION_INVALID_OR_UNCOVERED', 'CENSUS_UNVERIFIED'] };
const ANCHOR_KEYS = ['rc5Manifest', 'rsaManifest', 'rsaSeal', 'rsbManifest', 'rsbSeal', 'rscaManifest', 'rscaSeal', 'rscbManifest', 'rscbSeal', 'rsccManifest', 'rsccSeal', 'rsdaManifest',
  'rsdaSeal', 'rsdbManifest', 'rsdbSeal'];
const MAX_DRAINS = 256; const MAX_PROOFS = 64;

export interface ConnectionIds { readonly registrationId: string; readonly serverBootId: string; readonly controlConnectionId: string; readonly handoffConnectionId: string }
const CASE_KEYS = ['preSnapshotId', 'armIssued', 'armId', 'armExpiresAt', 'preToArmMs', 'armMs', 'readyMs', 'armFailure', 'handoffState', 'handoffCode', 'abandonedByOperator',
  'handoff', 'terminal', 'creditBlock', 'ledgerSource', 'ledgerWithheld', 'preCensus', 'postCensus', 'census', 'censusReason'] as const;
const caseOut = (m: CaseMeasure) => Object.fromEntries(CASE_KEYS.map(k => [k, m[k]]));
/**
 * The stricter-only effective state: a fault anywhere → FAILED; an invalid record or a recorded case still without FINAL coverage →
 * INCOMPLETE; RS-D-A: a census stop or a recorded case whose census did not MATCH → INCOMPLETE (CENSUS_UNVERIFIED).
 */
export function effectiveOf(baseState: string, run: MeasuredRun): { state: string; reason: string | null } {
  const ms = [...run.cases.values()];
  const want: [string, string] | null = ms.some(m => m.terminal !== null && m.terminal.detectedFault !== 'NONE') ? ['TERMINAL_FAILED', 'AUTHENTICATED_TERMINAL_FAULT']
    : run.armStop === 'OBSERVATION_INVALID' || ms.some(m => m.creditBlock === 'TERMINAL_NOT_FINAL' && m.terminal?.final !== true)
      ? ['TERMINAL_INCOMPLETE', 'TERMINAL_OBSERVATION_INVALID_OR_UNCOVERED']
      : run.armStop === 'CENSUS_CHANGED_UNEXPECTEDLY' || run.armStop === 'CENSUS_CONTINUITY_LOST' || run.armStop === 'TERMINAL_EXPIRED_UNCOLLECTED'
        || ms.some(m => m.census !== null && m.census !== 'MATCH')
        ? ['TERMINAL_INCOMPLETE', 'CENSUS_UNVERIFIED'] : null;
  return want !== null && RANK[want[0]]! > RANK[baseState]! ? { state: want[0], reason: want[1] } : { state: baseState, reason: null };
}

/** The v6 receipt of `run` (validated before it is returned); `order` is the run's own executed order (bound to its corpus). */
export function buildReceiptV6(session: ExecutionSession, run: MeasuredRun, cases: readonly EvalCase[], revision: RevisionRecord, connection: ConnectionIds): Record<string, unknown> {
  const base = buildReceipt(session, cases) as Record<string, any>;
  const effective = effectiveOf(String(base.run.state), run);
  const receipt = { schema: RECEIPT_V6, base, revision, connection, build: run.build, order: run.order, cases: Object.fromEntries([...run.cases].map(([id, m]) => [id, caseOut(m)])),
    drains: run.drains.map(e => ({ afterCaseId: e.afterCaseId, closurePolicyVersion: e.closurePolicyVersion, closureFenceEpoch: e.closureFenceEpoch, drain: e.drain })),
    proofs: run.proofs.map(e => ({ afterCaseId: e.afterCaseId, platform: e.platform, privacy: e.privacy })),
    armStop: run.armStop, effective, provenance: PROVENANCE_V6, flags: FLAGS_V6 };
  assertReceiptV6(receipt, cases);
  return receipt;
}

const exactKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => k in o);
const nullOr = <T>(v: unknown, ok: (x: unknown) => x is T | boolean): boolean => v === null || ok(v) === true;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const DEC = /^(0|[1-9][0-9]{0,18})$/;
const isDec = (v: unknown): v is string => typeof v === 'string' && DEC.test(v) && BigInt(v) <= 9223372036854775807n;
/** A census record: exactly the 05 payload without `tasks`. */
function censusRecordOk(c: unknown): boolean {
  if (c === null) return true;
  if (!exactKeys(c, CENSUS_RECORD_KEYS) || !isUuid(c.censusId) || !isUuid(c.guardEpoch) || !['COMPLETE', 'UNKNOWN'].includes(c.coverage as string)) return false;
  return CENSUS_RECORD_KEYS.filter(k => k.endsWith('Count')).every(k => isDec(c[k])) && BigInt(c.activeTaskCount as string) <= 4n && BigInt(c.pendingCommitCount as string) <= 4n;
}
/** Exact v6 allowlist, the unchanged v2 check of `base`, and the accepted scan of the whole object. Throws RECEIPT_UNSAFE only. */
export function assertReceiptV6(r: unknown, cases: readonly EvalCase[]): void {
  const ok = (() => {
    if (!exactKeys(r, ['schema', 'base', 'revision', 'connection', 'build', 'order', 'cases', 'drains', 'proofs', 'armStop', 'effective', 'provenance', 'flags'])
      || r.schema !== RECEIPT_V6) return false;
    // v6: the build C identified (null before the first IDENTITY) — every recorded platform proof names the same build.
    if (!(r.build === null || (exactKeys(r.build, ['buildManifestSha256']) && typeof r.build.buildManifestSha256 === 'string' && HEX64.test(r.build.buildManifestSha256)))) return false;
    if (!Array.isArray(r.proofs) || r.proofs.length > MAX_PROOFS || (r.proofs.length > 0 && r.build === null)) return false;
    for (const e of r.proofs) {
      if (!exactKeys(e, ['afterCaseId', 'platform', 'privacy']) || !(e.afterCaseId === null || cases.some(x => x.caseId === e.afterCaseId))) return false;
      let pl, pr;
      try { pl = decodePlatformProof(e.platform); pr = decodePrivacyProof(e.privacy); } catch { return false; }
      const c = r.connection as Record<string, unknown> | null; // rc2 N10: bound to the run's own connection
      if (!c || pl.environmentId !== c.registrationId || pl.serverBootId !== c.serverBootId || pr.environmentId !== c.registrationId) return false;
      if (pl.buildManifestSha256 !== (r.build as { buildManifestSha256: string }).buildManifestSha256) return false;
    }
    try { assertReceipt(r.base, cases); } catch { return false; }
    if (JSON.stringify(r.provenance) !== JSON.stringify(PROVENANCE_V6) || JSON.stringify(r.flags) !== JSON.stringify(FLAGS_V6)) return false;
    if (!exactKeys(r.order, ['rule', 'sha256', 'frozenOrderSha256']) || r.order.rule !== ORDER_RULE || r.order.sha256 !== GROUPED_ORDER_SHA256
      || r.order.frozenOrderSha256 !== (r.base as { artifact?: { orderSha256?: unknown } }).artifact?.orderSha256) return false;
    if (!Array.isArray(r.drains) || r.drains.length > MAX_DRAINS) return false;
    for (const e of r.drains) {
      if (!exactKeys(e, ['afterCaseId', 'closurePolicyVersion', 'closureFenceEpoch', 'drain']) || !(e.afterCaseId === null || cases.some(x => x.caseId === e.afterCaseId))
        || !(e.closurePolicyVersion === null || (isDec(e.closurePolicyVersion) && e.closurePolicyVersion !== '0'))
        || !(e.closureFenceEpoch === null || isDec(e.closureFenceEpoch)) || (e.closurePolicyVersion === null) !== (e.closureFenceEpoch === null)) return false;
      try { decodeDrain(e.drain); } catch { return false; }
    }
    if (!exactKeys(r.revision, ['anchors', 'instrumentRevisionSha256', 'rc5ToolSha256', 'rebuiltOutputsSha256', 'expectedFiles', 'candidate'])
      || !exactKeys(r.revision.candidate, ['id', 'sha256', 'accepted']) || r.revision.candidate.id !== CANDIDATE_ID
      || typeof r.revision.candidate.sha256 !== 'string' || !HEX64.test(r.revision.candidate.sha256) || typeof r.revision.candidate.accepted !== 'boolean'
      || !exactKeys(r.revision.anchors, ANCHOR_KEYS) || !Object.values(r.revision.anchors).every(h => typeof h === 'string' && HEX64.test(h))
      || ![r.revision.instrumentRevisionSha256, r.revision.rc5ToolSha256, r.revision.rebuiltOutputsSha256].every(h => typeof h === 'string' && HEX64.test(h))
      || !isInt(r.revision.expectedFiles)) return false;
    if (!exactKeys(r.connection, ['registrationId', 'serverBootId', 'controlConnectionId', 'handoffConnectionId']) || !Object.values(r.connection).every(isUuid)) return false;
    if (!(r.armStop === null || (ARM_STOPS as readonly unknown[]).includes(r.armStop))) return false;
    const baseState = String((r.base as { run?: { state?: unknown } }).run?.state);
    if (!exactKeys(r.effective, ['state', 'reason']) || RANK[r.effective.state as string] === undefined
      || (r.effective.reason === null ? r.effective.state !== baseState
        : !(RANK[r.effective.state as string]! > RANK[baseState]! && (EFFECTIVE_REASONS[r.effective.state as string] ?? []).includes(r.effective.reason as string)))) return false;
    if (typeof r.cases !== 'object' || r.cases === null || Array.isArray(r.cases)) return false;
    for (const [id, c] of Object.entries(r.cases)) {
      if (!cases.some(x => x.caseId === id) || !exactKeys(c, CASE_KEYS)) return false;
      if (typeof c.armIssued !== 'boolean' || typeof c.abandonedByOperator !== 'boolean' || typeof c.ledgerWithheld !== 'boolean' || !(c.creditBlock === null || (CREDIT_BLOCKS as readonly unknown[]).includes(c.creditBlock))) return false;
      if (!isUuid(c.preSnapshotId) || !nullOr(c.armId, isUuid) || !(c.armExpiresAt === null || (typeof c.armExpiresAt === 'string' && TIME.test(c.armExpiresAt))) || !nullOr(c.preToArmMs, isInt) || !nullOr(c.armMs, isInt)
        || !nullOr(c.readyMs, isInt) || !nullOr(c.armFailure, (x): x is string => typeof x === 'string' && /^[A-Z_]{1,64}$/.test(x))
        || !['NOT_RECEIVED', 'COMMITTED', 'UNVERIFIED'].includes(c.handoffState as string) || !nullOr(c.handoffCode, isFailureCode)
        || !['CONTROLLER_POST_SNAPSHOT', 'UNAVAILABLE'].includes(c.ledgerSource as string)) return false;
      if (!censusRecordOk(c.preCensus) || !censusRecordOk(c.postCensus) || !(c.census === null || (CENSUS_VERDICTS as readonly unknown[]).includes(c.census))
        || !(c.censusReason === null || (CENSUS_REASONS as readonly unknown[]).includes(c.censusReason)) || ((c.census === null || c.census === 'MATCH') !== (c.censusReason === null))) return false;
      // rc2 (review N6): a verdict exists only with both records; MATCH only within one guard epoch.
      if (c.census !== null && (c.preCensus === null || c.postCensus === null)) return false;
      if (c.census === 'MATCH' && (c.preCensus as { guardEpoch: string }).guardEpoch !== (c.postCensus as { guardEpoch: string }).guardEpoch) return false;
      try { if (c.handoff !== null) decodeHandoffSummary(c.handoff); if (c.terminal !== null) decodeTerminalObservation(c.terminal); } catch { return false; }
    }
    return true;
  })();
  const text = JSON.stringify(r);
  const leak = cases.some(c => (c.rationale.length >= 12 && text.includes(JSON.stringify(c.rationale).slice(1, -1))) || text.includes(JSON.stringify(c.question).slice(1, -1)));
  if (!ok || receiptIssues(r, cases).length > 0 || leak) reject('RECEIPT_UNSAFE');
}

/**
 * Exclusive temp file (fsync) → atomic rename → directory fsync (the PENDING summary is durable before the ACK, 06). On macOS Node's
 * fsync is libuv's F_FULLFSYNC (measured: tests/reval-fsync.test.ts; RS-D-C closes the carried F_FULLFSYNC item). Throws on failure,
 * leaving the previous file intact.
 */
export function durableWrite(dir: string, name: string, text: string): string {
  const target = join(dir, name); const temp = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
    const dfd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch (e) { try { rmSync(temp, { force: true }); } catch { /* the previous file stays intact */ } throw e; }
  return target;
}
/** Validated receipt → `durableWrite`. */
export function writeReceiptV6(dir: string, receipt: Record<string, unknown>, cases: readonly EvalCase[], name: string): string {
  assertReceiptV6(receipt, cases);
  if (!/^[A-Z0-9_.-]{1,80}\.json$/i.test(name)) reject('RECEIPT_NAME_INVALID');
  try { return durableWrite(dir, name, `${JSON.stringify(receipt, null, 2)}\n`); } catch { return reject('RECEIPT_WRITE_FAILED'); }
}
