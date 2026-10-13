// Ask Atlas view state (docs/stage5/ask/03 "Browser state"; ASK-REMOTE docs/stage5/ask/remote/02 "Consent and generation
// isolation"). DOM-free and token-free; only validated projections and fixed codes. There is no question text, transcript or
// history here: one answer at most, cleared by every scope change. Consent is one boolean for the current draft only.
import type { AskAnswerView, AskDisclosure, AskErrorView, QuestionProblem } from './ask-contracts.ts';
import type { FailureCode } from './contracts.ts';

/**
 * Capability of the current credential: IDLE (not asked yet), LOADING, OFF (404), MOCK (validated V1 200), REMOTE (validated
 * V2 200 with its disclosure) or ERROR (unavailable — incl. ASK_REMOTE_NOT_ADMITTED and a current policy change — with retry).
 */
export type AskCapabilityStatus = 'IDLE' | 'LOADING' | 'OFF' | 'MOCK' | 'REMOTE' | 'ERROR';
/** A fixed failure: a transport code, or HTTP_ERROR with its status and validated AskErrorV1 (null when the body was not one). */
export interface AskFailureView { readonly code: FailureCode; readonly status: number | null; readonly ask: AskErrorView | null }
export interface AskCapabilityState {
  readonly status: AskCapabilityStatus; readonly failure: AskFailureView | null;
  /** The validated admission tuple shown to the operator: set only with status REMOTE. Informational, not authority. */
  readonly disclosure: AskDisclosure | null;
}

/**
 * Local refusals: nothing was sent. NO_FOCUS: "Use selected observation" without a selected observation; REQUEST_ID: no
 * canonical UUIDv4 could be generated for the request; CONSENT: a REMOTE question without the operator's current consent.
 */
export type AskRefusal = QuestionProblem | 'NO_FOCUS' | 'REQUEST_ID' | 'CONSENT';
export type AskStatus = 'IDLE' | 'PENDING' | 'READY' | 'ERROR' | 'REFUSED';
export interface AskState {
  readonly status: AskStatus;
  readonly answer: AskAnswerView | null;
  readonly failure: AskFailureView | null;
  readonly refusal: AskRefusal | null;
  /** The exact observation ID the pending question was asked about, or null. */
  readonly focus: string | null;
  /**
   * The operator's deliberate "Use selected observation" choice (only true with a selected observation). A user change is a
   * generation boundary (controller-ask.ts focusChanged); a send keeps it, a scope reset clears it without being a user change.
   */
  readonly useFocus: boolean;
  /** Changes on every send, reset and focus change: the view then clears the question input (the checkbox follows useFocus). */
  readonly inputGeneration: number;
  /**
   * REMOTE only: the operator manually checked the consent box for the CURRENT draft and disclosure. Every reset, edit, send,
   * focus or capability change makes it false; it never carries to a new draft and is never stored anywhere else.
   */
  readonly consent: boolean;
}

export const ASK_CAPABILITY_IDLE: AskCapabilityState = Object.freeze({ status: 'IDLE', failure: null, disclosure: null });
export const askIdle = (inputGeneration: number, useFocus = false): AskState =>
  Object.freeze({ status: 'IDLE', answer: null, failure: null, refusal: null, focus: null, useFocus, inputGeneration, consent: false });
