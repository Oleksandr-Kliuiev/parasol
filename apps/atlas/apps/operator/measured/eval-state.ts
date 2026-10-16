// View state of the measured evaluation pane (04 "Synthetic evaluation focus choice"; rs-c brief C §3). DOM-free and token-free:
// fixed codes, the safe pair metadata and one validated answer/error at most. The question draft itself lives only in the
// textarea (the view clears it when `formGeneration` changes); the session token and the handoff values live only in the
// measured holder / controller closures.
import type { AskAnswerView, QuestionProblem } from '../src/ask-contracts.ts';
import type { AskFailureView } from '../src/ask-state.ts';
import type { PairView } from './eval-contracts.ts';
import type { HandoffFailure } from './eval-transport.ts';

export type PairStatus = 'IDLE' | 'PENDING' | 'PAIRED' | 'ERROR';
export type EvalStatus = 'IDLE' | 'PENDING' | 'READY' | 'ERROR' | 'REFUSED';
/** NONE: no eligible completion; AVAILABLE: the current completion may be sent once; SENT: 204 (not proof the instrument committed). */
export type SendStatus = 'NONE' | 'AVAILABLE' | 'SENDING' | 'SENT' | 'FAILED';
/** Local refusals (nothing was sent). */
export type EvalRefusal = QuestionProblem | 'NO_CHOICE' | 'CONSENT' | 'NOT_READY' | 'REQUEST_ID';
/**
 * rc2 F2 (04 "apply existing current-generation error rules"): a current 403 blocks pairing until the operator deliberately
 * re-selects the client; a current policy change (409 ASK_REMOTE_POLICY_CHANGED, or a handoff refusing the paused/changed policy)
 * blocks it until a fresh capability exists (in this build: reconnect).
 */
export type EvalBlock = 'SCOPE_REFUSED' | 'POLICY_CHANGED';

export interface EvalUiState {
  readonly pairStatus: PairStatus; readonly pairFailure: HandoffFailure | null;
  /** The current pair's safe metadata (its fixed focus choice); null when unpaired or after any pair loss. */
  readonly pair: PairView | null;
  /** Changes when the draft must be cleared (submit capture, external invalidation, pair change); never on a user edit. */
  readonly formGeneration: number;
  /** The operator deliberately selected the one fixed choice for the CURRENT draft. */
  readonly choice: boolean;
  /** The operator manually checked consent for the current draft, choice, pair and capability tuple. */
  readonly consent: boolean;
  readonly status: EvalStatus; readonly answer: AskAnswerView | null; readonly failure: AskFailureView | null; readonly refusal: EvalRefusal | null;
  readonly send: SendStatus; readonly sendFailure: HandoffFailure | null;
  readonly block: EvalBlock | null;
}

export const EVAL_INITIAL: EvalUiState = Object.freeze({ pairStatus: 'IDLE', pairFailure: null, pair: null, formGeneration: 0, choice: false, consent: false,
  status: 'IDLE', answer: null, failure: null, refusal: null, send: 'NONE', sendFailure: null, block: null });

/** The pane after an invalidation: form and evidence cleared; the pair kept only when `keepPair`. */
export function cleared(s: EvalUiState, keepPair: boolean, clearDraft: boolean): EvalUiState {
  return Object.freeze({ ...s, pairStatus: keepPair ? s.pairStatus : 'IDLE', pairFailure: keepPair ? s.pairFailure : null, pair: keepPair ? s.pair : null,
    formGeneration: clearDraft ? s.formGeneration + 1 : s.formGeneration, choice: false, consent: false, status: 'IDLE', answer: null, failure: null,
    refusal: null, send: 'NONE', sendFailure: null });
}
