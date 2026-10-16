// Transient V2 evidence of ONE case: the AskRequestV2 that was actually sent and the server reply, each pasted by the
// operator (or produced by the offline fake V2). Both are parsed with the accepted strict JSON parser and validated with
// the ACCEPTED validators (server request parser; browser V2 answer/error validators) BEFORE any boolean is derived. A
// validated answer is then judged by the accepted independent comparator against the frozen fixture expectation for the
// OBSERVED intent, regardless of the expected label. Only fixed enums/booleans and the validated correlation UUID leave
// this module; question, bodies, answer and observed intent stay in locals of the caller and are dropped.
import { validateAskError, validateRemoteAnswer, validateRemoteCapability } from '../../apps/operator/src/validate-ask.ts';
import { askRemoteRequest } from '../../packages/ask/remote/input.ts';
import { parseStrictJson } from '../../packages/ask/remote/json.ts';
import type { EvalCase, Intent } from '../ask-remote-eval/dataset.ts';
import type { FixtureFile } from '../ask-remote-eval/fixtures.ts';
import type { PreparedFixture } from '../ask-remote-eval/harness.ts';
import { checkAnswer } from '../ask-remote-eval/predicates.ts';
import type { TruthFailure } from '../ask-remote-eval/predicates.ts';
import { httpStatus, reject, transientText } from './validate.ts';

export interface CaseContext { readonly frozen: EvalCase; readonly fixture: PreparedFixture; readonly scope: FixtureFile['scope'] }
export interface Tuple { readonly admissionId: string; readonly policyVersion: string }

/** Strict JSON of a pasted value. A paste that is not JSON is re-promptable (PASTE_REJECTED) and derives nothing. */
export function strictJson(text: unknown): unknown {
  const value = transientText(text, 'PASTE_REJECTED');
  try { return parseStrictJson(value); } catch { return reject('PASTE_REJECTED'); }
}

/** `parsed:false` = the pasted request failed the accepted parser: a LOCAL handoff failure, not proof of what was sent. */
export type RequestCheck = { readonly requestId: string | null; readonly deviation: boolean; readonly parsed: boolean };
/**
 * The request actually sent. A parsed AskRequestV2 whose question, requested focus or acknowledgement tuple differs from the
 * frozen case / captured tuple is a POST-SUBMISSION deviation (consumed CASE_FAIL). A paste the accepted parser rejects
 * proves nothing about the sent bytes: it is an unattributed local handoff failure (never a deviation or server fault).
 */
export function checkRequest(text: unknown, ctx: CaseContext, tuple: Tuple): RequestCheck {
  const body = strictJson(text);
  try {
    const r = askRemoteRequest(body);
    const deviation = r.question !== ctx.frozen.question || r.observationId !== ctx.fixture.spec.requestedFocus
      || r.acknowledgement.admissionId !== tuple.admissionId || r.acknowledgement.policyVersion !== tuple.policyVersion;
    return { requestId: r.requestId, deviation, parsed: true };
  } catch { return { requestId: null, deviation: false, parsed: false }; }
}

export interface TransientHttp { readonly status: unknown; readonly correlationHeader: unknown; readonly body: unknown }
/** Truth categories of the plan's safety table, split from the comparator's fixed failure codes. */
export type TruthCategory = 'SCHEMA' | 'CLAIMS' | 'COVERAGE' | 'URGENCY';
const CATEGORY: Readonly<Record<TruthFailure, TruthCategory>> = {
  SHAPE: 'SCHEMA', PROVENANCE: 'SCHEMA', FOCUS: 'CLAIMS', INTENT_ECHO: 'CLAIMS', STATUS: 'CLAIMS', EVIDENCE: 'CLAIMS', REFS: 'CLAIMS', CLAIMS: 'CLAIMS',
  OBSERVATION_DATA: 'CLAIMS', RESOURCE_DATA: 'CLAIMS', RESOURCE_STATUS: 'CLAIMS', ENTITY: 'CLAIMS', URGENCY: 'URGENCY', COVERAGE: 'COVERAGE'
};
export interface Truth { readonly pass: boolean; readonly claims: boolean; readonly coverage: boolean; readonly urgency: boolean; readonly schema: boolean }
export type Observed =
  /** observedIntent is TRANSIENT: the caller passes it to the in-memory supervisor and never persists it. */
  | { readonly kind: 'ANSWER'; readonly observedIntent: Intent; readonly truth: Truth; readonly correlationId: string }
  | { readonly kind: 'ERROR'; readonly code: string; readonly correlationId: string }
  /** The PASTED reply could not be validated (validator, header, request binding or JSON): an UNATTRIBUTED local handoff
   * failure. It is never reported as an observed server ASK_REMOTE_INVALID or a schema safety violation. */
  | { readonly kind: 'LOCAL_HANDOFF_UNVERIFIED'; readonly detail: HandoffDetail };
export const HANDOFF_DETAILS = ['REQUEST_UNPARSED', 'ANSWER_VALIDATOR_REJECTED', 'ERROR_ENVELOPE_REJECTED', 'REPLY_UNPARSEABLE', 'CORRELATION_HEADER_INVALID'] as const;
export type HandoffDetail = typeof HANDOFF_DETAILS[number];

export function truthOf(failures: readonly TruthFailure[]): Truth {
  const hit = new Set(failures.map(f => CATEGORY[f]));
  return { pass: failures.length === 0, claims: !hit.has('CLAIMS'), coverage: !hit.has('COVERAGE'), urgency: !hit.has('URGENCY'), schema: !hit.has('SCHEMA') };
}

function headersOf(value: unknown): Headers | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  try { return new Headers({ 'x-atlas-correlation-id': value }); } catch { return null; }
}

/**
 * The server reply for the request with `requestId`. `unparseable: true` is the operator's explicit statement that the
 * real body was not JSON; otherwise a non-JSON paste is re-promptable (PASTE_REJECTED). Every local validation failure is
 * LOCAL_HANDOFF_UNVERIFIED; only a reply that passes the accepted validators is attributed to the server.
 */
export function checkResponse(http: TransientHttp, ctx: CaseContext, requestId: string | null, unparseable = false): Observed {
  const status = httpStatus(typeof http.status === 'number' ? String(http.status) : http.status);
  const handoff = (detail: HandoffDetail): Observed => ({ kind: 'LOCAL_HANDOFF_UNVERIFIED', detail });
  if (unparseable) return handoff('REPLY_UNPARSEABLE');
  const body = strictJson(http.body);
  const headers = headersOf(http.correlationHeader);
  if (headers === null) return handoff('CORRELATION_HEADER_INVALID');
  if (status === 200) {
    if (requestId === null) return handoff('REQUEST_UNPARSED');
    try {
      const view = validateRemoteAnswer(body, headers, { requestId, workspaceId: ctx.scope.workspaceId, clientId: ctx.scope.clientId, sourceMode: 'db',
        focusObservationId: ctx.fixture.spec.requestedFocus });
      const observedIntent = view.intent as Intent;
      const result = checkAnswer(body, ctx.fixture.spec.expected, observedIntent, ctx.fixture.spec.requestedFocus, ctx.scope, ctx.fixture.facts);
      return { kind: 'ANSWER', observedIntent, truth: truthOf(result.failures), correlationId: view.correlationId };
    } catch { return handoff('ANSWER_VALIDATOR_REJECTED'); }
  }
  try {
    const error = validateAskError(body, headers, status, true);
    return { kind: 'ERROR', code: error.code, correlationId: error.correlationId };
  } catch { return handoff('ERROR_ENVELOPE_REJECTED'); }
}

/** Capability observation (read-only preflight): exact AskCapabilityV2 → tuple; 503 ASK_REMOTE_NOT_ADMITTED → inactive. The
 * validated correlation UUID is returned so the caller can refuse a re-pasted reply; that is NOT proof of server freshness. */
export type CapabilityCheck = { readonly kind: 'ACTIVE'; readonly tuple: Tuple; readonly correlationId: string }
  | { readonly kind: 'INACTIVE'; readonly correlationId: string } | { readonly kind: 'UNAVAILABLE' };
export function checkCapability(http: TransientHttp): CapabilityCheck {
  const status = httpStatus(typeof http.status === 'number' ? String(http.status) : http.status);
  const body = strictJson(http.body);
  const headers = headersOf(http.correlationHeader);
  if (headers === null) return { kind: 'UNAVAILABLE' };
  try {
    const correlationId = headers.get('x-atlas-correlation-id')!;
    if (status === 200) { const d = validateRemoteCapability(body, headers); return { kind: 'ACTIVE', tuple: { admissionId: d.admissionId, policyVersion: d.policyVersion }, correlationId }; }
    return validateAskError(body, headers, status, true).code === 'ASK_REMOTE_NOT_ADMITTED' ? { kind: 'INACTIVE', correlationId } : { kind: 'UNAVAILABLE' };
  } catch { return { kind: 'UNAVAILABLE' }; }
}
