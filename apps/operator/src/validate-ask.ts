// Ask responses (docs/stage5/ask/02_CONTRACTS.md): AskCapabilityV1, AskErrorV1 and the whole AskAnswerV1; ASK-REMOTE
// (docs/stage5/ask/remote/02): AskCapabilityV2, the remote error codes and the whole AskAnswerV2. DOM-free.
// The answer is validated as a whole before anything is committed: exact keys, the request it answers, scope, modes, the
// bank (validate-ask-facts.ts), coverage honesty, the independent urgency set and the exact compiler matrix with its
// focus/tuple/entity/state bindings. Any violation discards the whole answer; nothing partial is ever rendered. The
// planner's private selection (which refs it chose among eligible ones) is enforced by the server, not re-derived here.
// V1 and V2 differ only in their version/mode/provenance envelope; both run the same answerFacts predicates.
import { URGENT_SEVERITIES, SCOPE_ID_PATTERN } from './contracts.ts';
import type { ContextMode } from './contracts.ts';
import {
  ASK_ERROR_CODES, ASK_HTTP_STATUS, ASK_INTENTS, ASK_LIMITS, ASK_REMOTE_ERROR_CODES, ASK_REMOTE_HTTP_STATUS, ASK_STATUSES, CLAIM_CODES,
  REMOTE_DISCLOSURE, REMOTE_PROVENANCE, UUID_V4, policyVersionValid
} from './ask-contracts.ts';
import type {
  AskAnswerMode, AskAnswerView, AskClaim, AskCoverage, AskDisclosure, AskErrorCode, AskErrorView, AskFact, AskIntent, AskRemoteErrorCode, AskStatus, ClaimCode
} from './ask-contracts.ts';
import { activeExceptFocus, exactKeys, validateBank, validateCoverage } from './validate-ask-facts.ts';
import { array, fail, matching, oneOf, time } from './validate-core.ts';
import type { Json } from './validate-core.ts';

/** The server correlation header, required as a canonical lowercase UUIDv4. */
function correlationHeader(headers: Headers): string {
  const value = headers.get('x-atlas-correlation-id');
  if (value === null || !UUID_V4.test(value)) fail();
  return value as string;
}

/** Capability 200: exactly `{contractVersion:'AskCapabilityV1', mode:'mock', questionMaxCodepoints:2000}`; correlation by header only. */
export function validateCapability(value: unknown, headers: Headers): 'mock' {
  const row = exactKeys(value, ['contractVersion', 'mode', 'questionMaxCodepoints']);
  if (row.contractVersion !== 'AskCapabilityV1' || row.mode !== 'mock' || row.questionMaxCodepoints !== ASK_LIMITS.questionCodePoints) fail();
  correlationHeader(headers);
  return 'mock';
}

const DISCLOSURE_KEYS = ['contractVersion', 'admissionId', 'policyVersion', 'provider', 'model', 'profile', 'sent', 'dataClass', 'region', 'retention',
  'reserveMicroUsd'];
/**
 * Remote capability 200 (docs/stage5/ask/remote/02): exactly `{contractVersion:'AskCapabilityV2', mode:'remote',
 * questionMaxCodepoints:2000, disclosure}` with EVERY disclosure key: the fixed values of REMOTE_DISCLOSURE (reserve the number
 * 300000), a lowercase UUIDv4 admissionId and a canonical decimal policyVersion string (BigInt range, never a Number).
 * Informational only: it proves neither authority nor an active admission; every question is rechecked by the API.
 */
export function validateRemoteCapability(value: unknown, headers: Headers): AskDisclosure {
  const row = exactKeys(value, ['contractVersion', 'mode', 'questionMaxCodepoints', 'disclosure']);
  if (row.contractVersion !== 'AskCapabilityV2' || row.mode !== 'remote' || row.questionMaxCodepoints !== ASK_LIMITS.questionCodePoints) fail();
  const d = exactKeys(row.disclosure, DISCLOSURE_KEYS);
  for (const [key, fixed] of Object.entries(REMOTE_DISCLOSURE)) if (d[key] !== fixed) fail();
  const admissionId = matching(d.admissionId, UUID_V4);
  if (!policyVersionValid(d.policyVersion)) fail();
  correlationHeader(headers);
  return Object.freeze({ admissionId, policyVersion: d.policyVersion as string });
}

const REMOTE_CODES: readonly (AskErrorCode | AskRemoteErrorCode)[] = [...ASK_ERROR_CODES, ...ASK_REMOTE_ERROR_CODES];
const fixedStatus = (code: AskErrorCode | AskRemoteErrorCode): number =>
  (ASK_REMOTE_ERROR_CODES as readonly string[]).includes(code) ? ASK_REMOTE_HTTP_STATUS[code as AskRemoteErrorCode] : ASK_HTTP_STATUS[code as AskErrorCode];

/**
 * AskErrorV1 of an enabled Ask route: exact keys, a known code whose fixed status is `status`, header = body correlation.
 * The code list is the accepted V1 list; `remote` (a REMOTE question, or capability discovery before its mode is known) adds
 * exactly the fixed remote codes of 02 with their statuses. The envelope and header rules are the same.
 */
export function validateAskError(value: unknown, headers: Headers, status: number, remote = false): AskErrorView {
  const row = exactKeys(value, ['contractVersion', 'code', 'correlationId']);
  if (row.contractVersion !== 'AskErrorV1') fail();
  const code = remote ? oneOf(row.code, REMOTE_CODES) : oneOf(row.code, ASK_ERROR_CODES);
  if (fixedStatus(code) !== status) fail();
  const correlationId = matching(row.correlationId, UUID_V4);
  if (correlationHeader(headers) !== correlationId) fail();
  return Object.freeze({ code, correlationId });
}

/** What the browser captured when it sent the question; the answer must be exactly for this request. */
export interface AskExpectation {
  readonly requestId: string; readonly workspaceId: string; readonly clientId: string; readonly sourceMode: ContextMode;
  readonly focusObservationId: string | null;
}

const isUrgent = (fact: AskFact): boolean => fact.kind === 'OBSERVATION' && URGENT_SEVERITIES.includes(fact.data.severity);

/**
 * Focus binding of the bank: a requested focus that was found is the FIRST fact and has exactly one entity fact, last, for
 * the same observation and its stored entity ID; a missing focus has neither; no focus means no entity fact.
 */
function focusFact(bank: readonly AskFact[], focus: string | null): AskFact | null {
  const found = focus === null ? undefined : bank.find(f => f.kind === 'OBSERVATION' && f.data.observationId === focus);
  const entities = bank.filter(f => f.kind === 'ENTITY');
  if (!found) {
    if (entities.length !== 0) fail();
    return null;
  }
  const entity = bank[bank.length - 1];
  if (bank[0] !== found || found.kind !== 'OBSERVATION' || entities.length !== 1 || !entity || entity.kind !== 'ENTITY'
    || entity.data.observationId !== focus || entity.data.entityId !== found.data.entityId) fail();
  return found;
}

/** Honest bounded counters: observation facts are the first ≤24 of page + extra focus; omissions are flagged exactly. */
function coverageMatchesBank(coverage: AskCoverage, bank: readonly AskFact[], focus: AskFact | null): void {
  const observations = bank.filter(f => f.kind === 'OBSERVATION').length;
  const resources = bank.filter(f => f.kind === 'RESOURCE_STATE').length;
  if (coverage.focusExtra && focus === null) fail();
  const candidates = coverage.observationsRead + (coverage.focusExtra ? 1 : 0);
  if (observations !== Math.min(ASK_LIMITS.bankObservations, candidates) || coverage.observationFactsOmitted !== candidates > observations) fail();
  if (coverage.urgentFactsOmitted && !coverage.observationFactsOmitted) fail();
  if (resources > coverage.resourcesRead || coverage.resourceFactsOmitted !== resources < coverage.resourcesRead) fail();
}

/** Claims of one answer: exactly one ref each, unique, in the bank; the matrix of 02 with every focus binding rechecked. */
function validateClaims(value: unknown, status: AskStatus, intent: AskIntent, bank: readonly AskFact[], focus: AskFact | null): readonly AskClaim[] {
  const claims = array(value, ASK_LIMITS.claims).map((raw): AskClaim => {
    const row = exactKeys(raw, ['code', 'refs']);
    const refs = array(row.refs, ASK_LIMITS.bankLimit);
    if (refs.length !== 1 || typeof refs[0] !== 'string') fail();
    return Object.freeze({ code: oneOf(row.code, CLAIM_CODES), ref: refs[0] as string });
  });
  if ((intent === 'UNSUPPORTED') !== (status === 'UNSUPPORTED')) fail();
  if ((claims.length === 0) !== (status !== 'ANSWER')) fail();
  if (new Set(claims.map(c => c.ref)).size !== claims.length) fail();
  const facts = new Map(bank.map(f => [f.ref, f] as const));
  const fact = (ref: string): AskFact => facts.get(ref) ?? fail();
  const sole = (code: ClaimCode | readonly ClaimCode[], kind: AskFact['kind']): AskFact => {
    if (claims.length !== 1) fail();
    const f = fact(claims[0]!.ref);
    if (f.kind !== kind || !(typeof code === 'string' ? [code] : code).includes(claims[0]!.code)) fail();
    return f;
  };
  if (status !== 'ANSWER') return Object.freeze(claims);
  if (intent === 'SUMMARY') {
    for (const claim of claims) {
      const f = fact(claim.ref);
      if (!((f.kind === 'OBSERVATION' && claim.code === 'OBSERVATION_RECORDED') || (f.kind === 'RESOURCE_STATE' && claim.code === 'RESOURCE_RECORDED'))) fail();
    }
  } else if (intent === 'WHY_URGENT') {
    const f = sole(['SOURCE_URGENT', 'SOURCE_NOT_URGENT_IN_READ'], 'OBSERVATION');
    if (focus === null || f !== focus || (claims[0]!.code === 'SOURCE_URGENT') !== isUrgent(f)) fail();
  } else if (intent === 'SOURCE_STATE') {
    const f = sole('RESOURCE_RECORDED', 'RESOURCE_STATE');
    if (focus === null || focus.kind !== 'OBSERVATION' || f.kind !== 'RESOURCE_STATE') return fail();
    if (f.data.source !== focus.data.source || f.data.resourceType !== focus.data.resourceType || f.data.connectionId !== focus.data.connectionId) fail();
  } else if (intent === 'ENTITY') {
    const f = sole(['ENTITY_CONFIRMED', 'ENTITY_UNRESOLVED', 'ENTITY_UNAVAILABLE'], 'ENTITY');
    if (focus === null || f.kind !== 'ENTITY' || f.data.observationId !== (focus.kind === 'OBSERVATION' ? focus.data.observationId : null)) return fail();
    if (claims[0]!.code !== `ENTITY_${f.data.state}`) fail();
  } else fail();
  return Object.freeze(claims);
}

const ANSWER_KEYS = ['contractVersion', 'requestId', 'correlationId', 'workspaceId', 'clientId', 'mode', 'sourceMode', 'status', 'intent',
  'generatedAt', 'focusObservationId', 'coverage', 'urgentRefs', 'claims', 'evidence'];

/** The whole AskAnswerV1 for exactly the captured request, or Invalid. Returns a fresh frozen projection. */
export function validateAnswer(value: unknown, headers: Headers, expected: AskExpectation): AskAnswerView {
  const row = exactKeys(value, ANSWER_KEYS);
  if (row.contractVersion !== 'AskAnswerV1' || row.mode !== 'mock') fail();
  return answerFacts(row, headers, expected, 'mock');
}

/**
 * The whole AskAnswerV2 of a REMOTE question (docs/stage5/ask/remote/02 "Remote answer"): EXACTLY the 15 V1 keys plus
 * `provenance`, contractVersion AskAnswerV2, mode remote, sourceMode db (the captured context too), and the exact fixed
 * provenance. Every other predicate is the SAME shared V1 check below (bank, coverage, focus, urgency, claim matrix): nothing
 * is loosened for V2, and a V1 answer, a mock mode or any other provenance discards the whole answer.
 */
export function validateRemoteAnswer(value: unknown, headers: Headers, expected: AskExpectation): AskAnswerView {
  const row = exactKeys(value, [...ANSWER_KEYS, 'provenance']);
  if (row.contractVersion !== 'AskAnswerV2' || row.mode !== 'remote' || row.sourceMode !== 'db' || expected.sourceMode !== 'db') fail();
  const provenance = exactKeys(row.provenance, Object.keys(REMOTE_PROVENANCE));
  for (const [key, fixed] of Object.entries(REMOTE_PROVENANCE)) if (provenance[key] !== fixed) fail();
  return answerFacts(row, headers, expected, 'remote');
}

/** The shared V1 predicates of an answer row whose version/mode/key set the caller has checked. */
function answerFacts(row: Json, headers: Headers, expected: AskExpectation, mode: AskAnswerMode): AskAnswerView {
  if (row.requestId !== expected.requestId || row.focusObservationId !== expected.focusObservationId) fail();
  if (matching(row.workspaceId, SCOPE_ID_PATTERN) !== expected.workspaceId || matching(row.clientId, SCOPE_ID_PATTERN) !== expected.clientId) fail();
  if (row.sourceMode !== expected.sourceMode) fail();
  const correlationId = matching(row.correlationId, UUID_V4);
  if (correlationHeader(headers) !== correlationId) fail();
  const status = oneOf(row.status, ASK_STATUSES);
  const intent = oneOf(row.intent, ASK_INTENTS);
  const generatedAt = time(row.generatedAt);
  const evidence = validateBank(row.evidence, expected.sourceMode);
  const coverage = validateCoverage(row.coverage, expected.sourceMode);
  const focus = focusFact(evidence, expected.focusObservationId);
  // Only an actual extra focus row (focusExtra) may have any lifecycle; a focus on the active page is an active row.
  activeExceptFocus(evidence, coverage.focusExtra && focus ? focus.ref : null);
  coverageMatchesBank(coverage, evidence, focus);
  // Independent urgency notice: exactly every HIGH/CRITICAL observation fact of the bank, each once.
  const urgentRefs = array(row.urgentRefs, ASK_LIMITS.bankObservations).map(ref => typeof ref === 'string' ? ref : fail());
  const urgent = evidence.filter(isUrgent).map(f => f.ref);
  if (new Set(urgentRefs).size !== urgentRefs.length || urgentRefs.length !== urgent.length || !urgent.every(ref => urgentRefs.includes(ref))) fail();
  const claims = validateClaims(row.claims, status, intent, evidence, focus);
  return Object.freeze({ mode, requestId: expected.requestId, correlationId, workspaceId: expected.workspaceId, clientId: expected.clientId,
    sourceMode: expected.sourceMode, status, intent, generatedAt, focusObservationId: expected.focusObservationId, coverage,
    urgentRefs: Object.freeze(urgentRefs), claims, evidence });
}
