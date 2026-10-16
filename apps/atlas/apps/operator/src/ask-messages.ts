// Fixed Ask Atlas text (docs/stage5/ask/01_SPEC.md). DOM-free. Claims are rendered only through these dictionaries plus
// validated fact fields; no server prose, body, exception or question is ever shown. Nothing here claims an LLM, general
// language understanding, root cause, exhaustive absence, client health or production readiness. REMOTE text names the
// remote interpreter only for intent choice; it never claims live/provider verification, sanitizing or exact pricing.
import type { AskAnswerMode, AskAnswerView, AskErrorCode, AskIntent, AskRemoteErrorCode, AskStatus, EntityState } from './ask-contracts.ts';
import type { AskFailureView, AskRefusal } from './ask-state.ts';
import { FAILURE_TEXT } from './messages.ts';

export const ASK_BADGE = 'Ask Atlas — local synthetic MOCK; no external model';
export const ASK_INTRO = 'Ask about the selected client\'s stored Atera/Huntress read. A local deterministic MOCK recognizes only the example '
  + 'questions below (exact phrase, any letter case, optional final “?”); every other question is answered as unsupported. It is not an LLM '
  + 'and does not understand general language. Nothing is sent to an external model, and no tool, action or source system is used.';
export const ASK_EXAMPLES_HEADING = 'Supported MOCK questions (exact phrases)';
export const ASK_EXAMPLE_NOTE: Record<Exclude<AskIntent, 'UNSUPPORTED'>, string> = {
  SUMMARY: 'summarizes this bounded stored read',
  WHY_URGENT: 'needs “Use selected observation”',
  SOURCE_STATE: 'needs “Use selected observation”',
  ENTITY: 'needs “Use selected observation”'
};
export const ASK_CONTEXT_REQUIRED = 'Ask Atlas is available once this client\'s context has been received and validated.';
export const ASK_NO_FOCUS = 'No observation is selected. Select one in the queue to ask about it.';
export const askLimitText = (points: number): string =>
  points > 2000 ? 'More than 2000 characters: too long to send.' : `${points} of 2000 characters.`;

export const ASK_CAPABILITY_LOADING = 'Checking whether Ask Atlas is enabled…';
export const ASK_CAPABILITY_ERROR = 'Ask Atlas availability could not be checked. Nothing else on this page was affected.';
export const ASK_RETRY_CAPABILITY = 'Check Ask Atlas again';

// ASK-REMOTE (docs/stage5/ask/remote/02 "Consent and generation isolation"): fixed local disclosure text only — no link,
// selector, price table, key entry or policy editor. The admission ID and policy version are shown as validated codes.
export const ASK_REMOTE_BADGE = 'Ask Atlas — REMOTE: OpenAI GPT-6 Luna interprets; facts compiled locally';
export const ASK_UNCONFIRMED_BADGE = 'Ask Atlas — mode not confirmed';
export const ASK_REMOTE_HEADLINE = 'OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.';
export const ASK_REMOTE_DISCLOSURE: readonly string[] = Object.freeze([
  'What leaves Atlas: your original question, exactly as typed (nothing is removed or masked), and a yes/no flag saying whether an '
    + 'observation is in focus. They are sent to OpenAI. Stored evidence does not leave Atlas: no observation, ID, name, email or source record is sent.',
  'Paid OpenAI API usage is billed separately from any chat or coding subscription.',
  'Retention follows the owner-verified OpenAI account policy (EU region). This page cannot verify or change it.',
  'Synthetic questions only: this slice accepts synthetic test questions. Do not type real customer data, names or secrets.',
  'This disclosure is information, not permission: the API checks your access and the active admission again for every question.'
]);
export const ASK_REMOTE_COST = 'Up to US$0.30 reserved per attempt; unknown outcomes retain this reservation.';
export const ASK_REMOTE_DISCLOSURE_SUMMARY = 'Remote Ask disclosure (read before consenting)';
export const ASK_REMOTE_CONSENT = 'I consent to sending this question to OpenAI and confirm it is synthetic.';
export const ASK_REMOTE_CONSENT_NOTE = 'Consent covers this one question only. Editing or sending it, or changing the focus, page, filter or client, clears the box.';
export const ASK_REMOTE_TASKS_HEADING = 'Supported tasks (any wording; everything else is answered as unsupported)';
export const ASK_REMOTE_TASK: Record<Exclude<AskIntent, 'UNSUPPORTED'>, string> = {
  SUMMARY: 'What needs attention in this client\'s bounded stored read (summary)',
  WHY_URGENT: 'Why the selected observation is urgent (source severity) — needs “Use selected observation”',
  SOURCE_STATE: 'How fresh the stored read of the selected observation is — needs “Use selected observation”',
  ENTITY: 'Which device or person the selected observation is confirmed for — needs “Use selected observation”'
};

export const ASK_REFUSAL_TEXT: Record<AskRefusal, string> = {
  EMPTY: 'Type a question first. Nothing was sent.',
  TOO_LONG: 'The question is longer than 2000 characters. Nothing was sent, and nothing was shortened.',
  INVALID: 'The question contains control characters or invalid text. Nothing was sent.',
  NO_FOCUS: '“Use selected observation” is checked, but no observation is selected. Nothing was sent.',
  REQUEST_ID: 'A request ID could not be created. Nothing was sent.',
  CONSENT: 'The consent box is not checked for this question. Read the disclosure and check it to send. Nothing was sent.'
};

export const ASK_PENDING = 'Asking Ask Atlas (local MOCK)…';
export const ASK_REMOTE_PENDING = 'Asking Ask Atlas REMOTE (OpenAI GPT-6 Luna interprets the question; facts are compiled locally)…';
export const ASK_RETRY_HINT = 'Nothing is retried automatically. To try again, type the question again: it is a new read.';
export const ASK_REMOTE_NOT_ADMITTED = 'Ask Atlas REMOTE is not admitted right now (no active owner admission for this workspace or client). '
  + 'It is unavailable, not switched off. Nothing else on this page was affected.';
export const ASK_REMOTE_POLICY_CHANGED = 'The remote Ask policy changed after your consent, so the question was cleared and not answered. '
  + 'Refresh the disclosure, read it again and consent again for a new question.';
export const ASK_REFRESH_DISCLOSURE = 'Refresh the remote Ask disclosure';
/** The capability region's fixed sentence for a failed or changed capability. */
export function askCapabilityErrorText(failure: AskFailureView | null): string {
  if (failure?.ask?.code === 'ASK_REMOTE_NOT_ADMITTED') return ASK_REMOTE_NOT_ADMITTED;
  if (failure?.ask?.code === 'ASK_REMOTE_POLICY_CHANGED') return ASK_REMOTE_POLICY_CHANGED;
  return ASK_CAPABILITY_ERROR;
}
const ASK_ERROR_TEXT: Partial<Record<AskErrorCode | AskRemoteErrorCode, string>> = {
  ASK_REQUEST_INVALID: 'The API refused the question as invalid. No answer was given.',
  ASK_CONTEXT_UNAVAILABLE: 'Ask Atlas is unavailable for this client: its stored context was not found. No answer is shown.',
  ASK_TOO_LARGE: 'The question or the stored read exceeded the Ask limits. No answer was given.',
  ASK_SCOPE_CHANGED: 'Your access changed while the answer was prepared, so it was discarded. Ask again for a new read.',
  ASK_BUSY: 'Ask Atlas is busy (local limits). Nothing was retried.',
  ASK_DEADLINE: 'Ask Atlas did not finish within its time limit. Nothing was retried.',
  ASK_PLANNER_INVALID: 'The local MOCK planner produced an invalid plan, so no answer was given.',
  ASK_AUDIT_FAILED: 'The answer could not be recorded in the audit log, so it was not delivered.',
  ASK_RUNTIME_NOT_READY: 'Ask Atlas is not ready. No answer was given.',
  ASK_SOURCE_INVALID: 'The stored source read did not pass validation, so no answer was given.',
  // Remote codes: fixed sentences only. An upstream failure is never a sign-in, access or OFF signal.
  ASK_REMOTE_NOT_ADMITTED: ASK_REMOTE_NOT_ADMITTED,
  ASK_REMOTE_POLICY_CHANGED: ASK_REMOTE_POLICY_CHANGED,
  ASK_REMOTE_BUDGET: 'The remote Ask spending cap for this period is reached, so no answer was given. Nothing was retried.',
  ASK_REMOTE_UNAVAILABLE: 'The remote interpreter was unavailable, so no answer was given. Your sign-in and access are unchanged. Nothing was retried; '
    + 'an attempt that may have reached OpenAI keeps its reservation.',
  ASK_REMOTE_INVALID: 'The remote interpreter did not return one valid supported task, so no answer was given. Nothing was retried.',
  ASK_REMOTE_MODEL_MISMATCH: 'The remote interpreter reported an unexpected model, so no answer was given. Nothing was retried.',
  ASK_REMOTE_USAGE_INVALID: 'The remote interpreter\'s usage report did not validate, so no answer was given. Nothing was retried.'
};
const ASK_UNAVAILABLE = 'Ask Atlas is unavailable here (not found). No answer is shown.';
/** The fixed explanation of a failure: by validated Ask code, by 404, or by the console's fixed transport code. */
export function askFailureText(failure: AskFailureView): string {
  if (failure.ask) return ASK_ERROR_TEXT[failure.ask.code] ?? FAILURE_TEXT.HTTP_ERROR;
  if (failure.status === 404) return ASK_UNAVAILABLE;
  return FAILURE_TEXT[failure.code];
}

export const ASK_STATUS_HEADING: Record<AskStatus, string> = {
  ANSWER: 'Answer from stored evidence',
  INSUFFICIENT: 'Insufficient stored evidence',
  UNSUPPORTED: 'Unsupported question'
};
export const ASK_INTENT_LABEL: Record<AskIntent, string> = {
  SUMMARY: 'Recognized: what needs attention (summary of this bounded read)',
  WHY_URGENT: 'Recognized: why the selected observation is urgent (source severity)',
  SOURCE_STATE: 'Recognized: how fresh the stored read of the selected observation is',
  ENTITY: 'Recognized: which device or person the selected observation is confirmed for',
  UNSUPPORTED: 'Not one of the supported MOCK questions'
};
/**
 * INSUFFICIENT means only that no supported claim was compiled (a valid empty plan may leave eligible evidence uncited).
 * The neutral sentence is always shown; the established notes are added only when the validated request/bank shows them.
 */
export const ASK_INSUFFICIENT_NEUTRAL = 'No supported claim was compiled for this question. This is not a finding about the source: the evidence '
  + 'returned with this answer is listed below, and nothing is concluded from the missing claim.';
export type InsufficientNote = 'EMPTY_EVIDENCE' | 'ASKED_WITHOUT_FOCUS' | 'NO_EXACT_TUPLE_READ';
export const ASK_INSUFFICIENT_NOTE: Record<InsufficientNote, string> = {
  EMPTY_EVIDENCE: 'This answer\'s bounded evidence has no facts.',
  ASKED_WITHOUT_FOCUS: 'This question is about a selected observation and was asked without one. To ask about one, select it, check '
    + '“Use selected observation” and ask again.',
  NO_EXACT_TUPLE_READ: 'No stored-read state with the selected observation\'s exact source, type and connection is among the evidence returned with this answer.'
};
/**
 * Notes for an INSUFFICIENT answer, each established by the validated request or bank — never inferred from the status,
 * which only says that no supported claim was compiled (the planner may leave eligible evidence uncited).
 */
export function insufficientNotes(answer: AskAnswerView): InsufficientNote[] {
  const notes: InsufficientNote[] = [];
  if (answer.evidence.length === 0) notes.push('EMPTY_EVIDENCE');
  if (answer.intent === 'SUMMARY' || answer.intent === 'UNSUPPORTED') return notes;
  if (answer.focusObservationId === null) return [...notes, 'ASKED_WITHOUT_FOCUS'];
  const focus = answer.evidence.find(f => f.kind === 'OBSERVATION' && f.data.observationId === answer.focusObservationId);
  if (answer.intent === 'SOURCE_STATE' && focus?.kind === 'OBSERVATION' && !answer.evidence.some(f => f.kind === 'RESOURCE_STATE'
    && f.data.source === focus.data.source && f.data.resourceType === focus.data.resourceType && f.data.connectionId === focus.data.connectionId)) {
    notes.push('NO_EXACT_TUPLE_READ');
  }
  return notes;
}

export const ASK_UNSUPPORTED_TEXT = 'Ask Atlas MOCK recognizes only the listed questions. Root cause, remediation, other clients, finance, Microsoft 365, '
  + 'exhaustive history and every other question are unsupported. No broader read, tool or action was used.';
/** REMOTE answers: the same fixed claim text; only the origin line and the unsupported wording name the remote interpreter. */
export const ASK_REMOTE_UNSUPPORTED_LABEL = 'Not one of the four supported tasks';
export const ASK_REMOTE_UNSUPPORTED_TEXT = 'Ask Atlas REMOTE supports only the four listed tasks. Root cause, remediation, other clients, finance, Microsoft 365, '
  + 'exhaustive history and every other question are unsupported. No broader read, tool or action was used.';
export const ASK_ANSWER_ORIGIN: Record<AskAnswerMode, string> = {
  mock: ' · local synthetic MOCK, not an LLM',
  remote: ' · task chosen by OpenAI GPT-6 Luna from your question; every fact and claim compiled locally by Atlas'
};

export const ASK_ENTITY_TEXT: Record<EntityState, string> = {
  CONFIRMED: 'Confirmed by its exact graph ID and a confirmed source link',
  UNRESOLVED: 'Unresolved: no confirmed person or device link for this observation. Nothing is inferred from names or hostnames.',
  UNAVAILABLE: 'Reference unavailable: the stored entity could not be confirmed in this read. Nothing is inferred from names or hostnames.'
};
export const ASK_NOT_URGENT = 'not HIGH or CRITICAL in this stored read. This does not mean the client is healthy.';
export const ASK_URGENT_REASON = 'the source marked it so; it stays urgent regardless of Atlas route, confidence or priority label.';
export const ASK_URGENT_HEADING = 'Urgent source evidence in this read (shown for every answer)';
export const ASK_URGENT_OMITTED = 'More urgent source observations were read than fit in this answer\'s bounded evidence; they are not listed here.';
export const ASK_NO_URGENT = 'No source HIGH/CRITICAL observation is in this answer\'s bounded evidence. This does not mean the client is healthy.';
export const ASK_ABSENCE = 'Anything not in this evidence is only absent from this stored bounded read; it may exist beyond it.';
export const ASK_SEPARATE_READ = 'This answer is a separate read with its own times. It is not one atomic snapshot and does not change the queue, detail or evidence on this page.';
export const ASK_FOCUS_NOT_RETURNED = 'It is not among the evidence returned with this answer.';
export const ASK_CITATION_HINT = 'Citation buttons open the matching evidence card below. They only show evidence returned with this answer.';
