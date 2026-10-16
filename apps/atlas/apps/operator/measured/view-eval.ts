// The measured evaluation panel (04 "Pairing and arm", "Synthetic evaluation focus choice"; rs-c brief C §3). Only createElement/
// textContent through the accepted dom helpers; fixed local text; no question, nonce or token ever enters an attribute, state or log.
// The panel is shown only for a connected credential, a selected client with a validated DB context and a validated REMOTE
// capability. The pairing control is a plain manual field (password type, cleared before the request); the pane exists only after a
// valid PAIR200, starts empty, and every box shows the controller's state (programmatic updates never fire `change`).
import { REMOTE_DISCLOSURE, codePoints } from '../src/ask-contracts.ts';
import { ASK_REFUSAL_TEXT, ASK_REMOTE_CONSENT, ASK_REMOTE_COST, ASK_REMOTE_DISCLOSURE, ASK_STATUS_HEADING, askFailureText, askLimitText } from '../src/ask-messages.ts';
import { byId, el, rebuild } from '../src/dom.ts';
import type { ConsoleState } from '../src/state.ts';
import { answerNodes } from '../src/view-ask-answer.ts';
import { code, fields } from '../src/view-parts.ts';
import type { EvalController } from './eval-controller.ts';
import type { EvalUiState, EvalRefusal } from './eval-state.ts';
import type { HandoffFailure } from './eval-transport.ts';

export const EVAL_TEXT = Object.freeze({
  heading: 'Evaluation — measured synthetic sandbox',
  intro: 'Measured evaluation build. Pair with the pairing code from the owner session, then for each case: type the question exactly, '
    + 'select the fixed focus choice, check consent, and click Ask only after the instrument prints GO_CLICK_ASK_NOW.',
  unpaired: 'Not paired. Enter the pairing code shown by the owner session (it is valid for 120 s and works once).',
  pairing: 'Pairing…',
  pairFailed: 'Pairing failed',
  pending: 'Asking (measured evaluation)…',
  noChoice: 'Select the fixed evaluation focus choice for this question first.',
  notReady: 'Not ready: pair, a validated remote capability and this client\'s DB context are required.',
  send: 'Send evaluation evidence',
  sending: 'Sending the evaluation evidence…',
  sent: 'Evidence sent to the server (HTTP 204). This does not prove that the instrument committed it — check the instrument.',
  sendFailed: 'Evidence not sent',
  sendHint: 'Send once, manually, for this exact answer. It is never retried; editing or any change clears it.',
  scopeRefused: 'Access to this client was refused (HTTP 403). The pairing ended. Select the client again in the list, then pair with a new code.',
  policyChanged: 'The remote Ask policy changed or is no longer active. The pairing ended and the disclosure is stale: Disconnect and connect again '
    + 'to refresh it, then pair with a new code.',
});
const CHOICE_TEXT = { NONE: 'No focus', FOUND: 'Focus on the fixture observation', MISSING: 'Focus on the frozen absent observation ID' } as const;

const handoffCode = (f: HandoffFailure) => f.handoff ?? (f.status === null ? f.code : `HTTP ${f.status}`);
const refusalText = (r: EvalRefusal): string => r === 'NO_CHOICE' ? EVAL_TEXT.noChoice : r === 'NOT_READY' ? EVAL_TEXT.notReady
  : r === 'CONSENT' ? ASK_REFUSAL_TEXT.CONSENT : r === 'REQUEST_ID' ? ASK_REFUSAL_TEXT.REQUEST_ID : ASK_REFUSAL_TEXT[r];

export interface EvalView { render(ui: EvalUiState, console: ConsoleState): void }

export function createEvalView(controller: EvalController): EvalView {
  const ui = {
    panel: byId('eval-panel', HTMLElement), heading: byId('eval-heading', HTMLElement), intro: byId('eval-intro', HTMLElement),
    pairForm: byId('eval-pair-form', HTMLFormElement), nonce: byId('eval-nonce', HTMLInputElement), pairStatus: byId('eval-pair-status', HTMLElement),
    pane: byId('eval-pane', HTMLElement), facts: byId('eval-facts', HTMLElement), question: byId('eval-question', HTMLTextAreaElement),
    limit: byId('eval-limit', HTMLElement), choice: byId('eval-choice', HTMLInputElement), choiceLabel: byId('eval-choice-label', HTMLElement),
    consent: byId('eval-consent', HTMLInputElement), submit: byId('eval-submit', HTMLButtonElement), status: byId('eval-status', HTMLElement),
    answer: byId('eval-answer', HTMLElement), sendRow: byId('eval-send-row', HTMLElement), send: byId('eval-send', HTMLButtonElement),
    sendStatus: byId('eval-send-status', HTMLElement)
  };
  ui.heading.textContent = EVAL_TEXT.heading; ui.intro.textContent = EVAL_TEXT.intro; ui.send.textContent = EVAL_TEXT.send;
  byId('eval-cost', HTMLElement).textContent = ASK_REMOTE_COST;
  byId('eval-consent-text', HTMLElement).textContent = ASK_REMOTE_CONSENT;
  byId('eval-disclosure', HTMLElement).replaceChildren(el('ul', 'plain-list small', ...ASK_REMOTE_DISCLOSURE.map(text => el('li', null, text))));
  const updateLimit = () => { ui.limit.textContent = askLimitText(codePoints(ui.question.value, 2001)); };
  updateLimit();
  ui.pairForm.addEventListener('submit', event => {
    event.preventDefault();
    const nonce = ui.nonce.value; ui.nonce.value = ''; // the pairing code never stays in the DOM
    controller.pair(nonce);
  });
  ui.question.addEventListener('input', () => { updateLimit(); controller.questionEdited(); });
  // Only a deliberate user change fires `change`; programmatic `checked` updates from state never do.
  ui.choice.addEventListener('change', () => { if (ui.choice.checked) controller.choose(); });
  ui.consent.addEventListener('change', () => controller.consentChanged(ui.consent.checked, ui.question.value));
  ui.submit.addEventListener('click', () => { controller.submit(ui.question.value, ui.choice.checked, ui.consent.checked); });
  ui.send.addEventListener('click', () => controller.sendEvidence());

  let formGeneration = -1;
  /** The answer currently rendered (identity): rebuilt only when it changes, so citation state is not reset by unrelated renders. */
  let shownAnswer: unknown = undefined;
  return {
    render(s: EvalUiState, c: ConsoleState): void {
      const ctx = c.context.status === 'READY' ? c.context.data : null;
      ui.panel.hidden = !(c.session === 'READY' && c.selection !== null && c.askCapability.status === 'REMOTE' && ctx !== null && ctx.mode === 'db');
      if (ui.panel.hidden) { ui.nonce.value = ''; }
      ui.nonce.disabled = s.block !== null; byId('eval-pair', HTMLButtonElement).disabled = s.block !== null;
      ui.pairStatus.textContent = s.block === 'SCOPE_REFUSED' ? EVAL_TEXT.scopeRefused : s.block === 'POLICY_CHANGED' ? EVAL_TEXT.policyChanged
        : s.pairStatus === 'PENDING' ? EVAL_TEXT.pairing
        : s.pairStatus === 'ERROR' && s.pairFailure ? `${EVAL_TEXT.pairFailed}: ${handoffCode(s.pairFailure)}`
          : s.pair ? `Paired until ${s.pair.expiresAt} (fixture ${s.pair.focus.fixtureId}, generation ${s.pair.focus.fixtureGeneration}).` : EVAL_TEXT.unpaired;
      ui.pane.hidden = s.pair === null;
      if (formGeneration !== s.formGeneration) { formGeneration = s.formGeneration; ui.question.value = ''; updateLimit(); }
      const pair = s.pair;
      ui.choiceLabel.replaceChildren(...(pair === null ? [] : pair.focus.focusState === 'NONE' ? [CHOICE_TEXT.NONE]
        : [CHOICE_TEXT[pair.focus.focusState], ' ', code(pair.focus.requestedFocus!)]));
      rebuild(ui.facts, ui.heading, pair === null ? [] : [fields([['Fixture', code(pair.focus.fixtureId)], ['Generation', code(pair.focus.fixtureGeneration)],
        ['Focus state', pair.focus.focusState], ['Provider and model', `${REMOTE_DISCLOSURE.provider} ${REMOTE_DISCLOSURE.model}`]], 'fields fields-compact')]);
      ui.choice.checked = s.choice; ui.consent.checked = s.consent;
      ui.submit.setAttribute('aria-disabled', String(s.status === 'PENDING' || !s.choice || !s.consent));
      ui.answer.setAttribute('aria-busy', String(s.status === 'PENDING'));
      const refused = s.refusal !== null && s.status !== 'REFUSED' ? `${refusalText(s.refusal)} ` : '';
      ui.status.textContent = refused + (s.status === 'PENDING' ? EVAL_TEXT.pending
        : s.status === 'READY' && s.answer ? `${ASK_STATUS_HEADING[s.answer.status]}: ${s.answer.claims.length} cited claim${s.answer.claims.length === 1 ? '' : 's'}.`
          : s.status === 'ERROR' && s.failure ? `No answer: ${askFailureText(s.failure)} (${s.failure.ask?.code ?? (s.failure.status === null ? s.failure.code : `HTTP ${s.failure.status}`)})`
            : s.status === 'REFUSED' && s.refusal ? refusalText(s.refusal) : '');
      const answer = s.status === 'READY' ? s.answer : null;
      if (answer !== shownAnswer) { shownAnswer = answer; rebuild(ui.answer, ui.heading, answer ? answerNodes(answer) : []); }
      ui.sendRow.hidden = s.send === 'NONE';
      ui.send.disabled = s.send !== 'AVAILABLE';
      ui.sendStatus.textContent = s.send === 'AVAILABLE' ? EVAL_TEXT.sendHint : s.send === 'SENDING' ? EVAL_TEXT.sending : s.send === 'SENT' ? EVAL_TEXT.sent
        : s.send === 'FAILED' && s.sendFailure ? `${EVAL_TEXT.sendFailed}: ${handoffCode(s.sendFailure)}` : '';
    }
  };
}
