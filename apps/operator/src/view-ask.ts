// Ask Atlas panel (docs/stage5/ask/01_SPEC.md "UI"; ASK-REMOTE docs/stage5/ask/remote/02). Shown only after a validated MOCK
// or REMOTE capability (or its failure with an explicit retry); OFF and not-yet-known hide it entirely. The question input is
// offered only for a current validated context (REMOTE: a DB one). The textarea, focus and consent checkboxes are cleared
// whenever the state's inputGeneration changes (every send and every reset) and on disconnect; the consent box always shows
// the state's consent. Nothing typed is kept in state; the question is read once per submit and handed to the controller.
// MOCK keeps its label, intro and exact examples; REMOTE shows only the fixed local disclosure, cost notice and four tasks.
import { button, byId, el, rebuild, untrusted } from './dom.ts';
import { MOCK_EXAMPLES, REMOTE_DISCLOSURE, REMOTE_TASKS, codePoints } from './ask-contracts.ts';
import type { AskDisclosure } from './ask-contracts.ts';
import {
  ASK_BADGE, ASK_CAPABILITY_LOADING, ASK_CONTEXT_REQUIRED, ASK_EXAMPLE_NOTE, ASK_EXAMPLES_HEADING, ASK_INTRO, ASK_NO_FOCUS, ASK_PENDING,
  ASK_REFRESH_DISCLOSURE, ASK_REFUSAL_TEXT, ASK_REMOTE_BADGE, ASK_REMOTE_CONSENT, ASK_REMOTE_CONSENT_NOTE, ASK_REMOTE_COST, ASK_REMOTE_DISCLOSURE,
  ASK_REMOTE_DISCLOSURE_SUMMARY, ASK_REMOTE_HEADLINE, ASK_REMOTE_PENDING, ASK_REMOTE_TASK, ASK_REMOTE_TASKS_HEADING, ASK_RETRY_CAPABILITY, ASK_RETRY_HINT,
  ASK_STATUS_HEADING, ASK_UNCONFIRMED_BADGE, askCapabilityErrorText, askFailureText, askLimitText
} from './ask-messages.ts';
import { askContext } from './controller-ask.ts';
import { selectedObservation } from './controller-evidence.ts';
import { answerNodes } from './view-ask-answer.ts';
import { code, fields } from './view-parts.ts';
import type { Controller } from './controller.ts';
import type { ConsoleState } from './state.ts';
import type { AskFailureView } from './ask-state.ts';

export interface AskView {
  render(state: ConsoleState, previous: ConsoleState | null): void;
  /** Disconnected: hide the panel, clear the input, both checkboxes, the answer and the status. */
  clear(): void;
}

function failureNodes(failure: AskFailureView): Node[] {
  const out: Node[] = [el('p', 'notice notice-error', askFailureText(failure), ' ', el('code', null, failure.ask?.code ?? (failure.status === null ? failure.code : `HTTP ${failure.status}`)))];
  if (failure.ask) out.push(el('p', 'muted small', 'Correlation ID ', code(failure.ask.correlationId)));
  return out;
}

/** The fixed local REMOTE disclosure: headline, what leaves Atlas, billing, retention, synthetic-only, the four tasks, values. */
function disclosureNodes(disclosure: AskDisclosure): Node[] {
  const values = el('details', 'ask-disclosure-values', el('summary', 'small', ASK_REMOTE_DISCLOSURE_SUMMARY), fields([
    ['Provider and model', `${REMOTE_DISCLOSURE.provider} ${REMOTE_DISCLOSURE.model}`], ['Profile', code(REMOTE_DISCLOSURE.profile)],
    ['Sent', `${REMOTE_DISCLOSURE.sent} (the question and a focus-present flag only)`], ['Accepted data', `${REMOTE_DISCLOSURE.dataClass} only`],
    ['Region', REMOTE_DISCLOSURE.region], ['Retention', REMOTE_DISCLOSURE.retention],
    ['Reserve per attempt', `${REMOTE_DISCLOSURE.reserveMicroUsd} micro-USD (US$0.30)`],
    ['Admission ID', code(disclosure.admissionId)], ['Policy version', code(disclosure.policyVersion)]
  ], 'fields fields-compact'));
  return [el('ul', 'plain-list small', ...ASK_REMOTE_DISCLOSURE.map(text => el('li', null, text))),
    el('p', 'strong small', ASK_REMOTE_TASKS_HEADING), el('ul', 'plain-list small', ...REMOTE_TASKS.map(task => el('li', null, ASK_REMOTE_TASK[task]))),
    values];
}

export function createAskView(controller: Controller): AskView {
  const ui = {
    panel: byId('ask-panel', HTMLElement), heading: byId('ask-heading', HTMLElement), badge: byId('ask-badge', HTMLElement),
    capability: byId('ask-capability', HTMLElement), capabilityAction: byId('ask-capability-action', HTMLElement), form: byId('ask-form', HTMLElement),
    context: byId('ask-context', HTMLElement), intro: byId('ask-intro', HTMLElement), examples: byId('ask-examples', HTMLElement),
    disclosure: byId('ask-disclosure', HTMLElement), question: byId('ask-question', HTMLTextAreaElement), limit: byId('ask-limit', HTMLElement),
    focus: byId('ask-focus', HTMLInputElement), focusNote: byId('ask-focus-note', HTMLElement), consentRow: byId('ask-consent-row', HTMLElement),
    consent: byId('ask-consent', HTMLInputElement), submit: byId('ask-submit', HTMLButtonElement), status: byId('ask-status', HTMLElement),
    answer: byId('ask-answer', HTMLElement)
  };
  ui.intro.textContent = ASK_INTRO;
  const items = MOCK_EXAMPLES.flatMap(example => [example.en, example.ru].map((text, i) => {
    const phrase = el('q', null, text);
    phrase.lang = i === 0 ? 'en' : 'ru';
    return el('li', null, phrase, ` — ${ASK_EXAMPLE_NOTE[example.intent]}`);
  }));
  ui.examples.replaceChildren(el('p', 'strong small', ASK_EXAMPLES_HEADING), el('ul', 'plain-list small', ...items));
  byId('ask-cost', HTMLElement).textContent = ASK_REMOTE_COST;
  byId('ask-consent-text', HTMLElement).textContent = ASK_REMOTE_CONSENT;
  byId('ask-consent-note', HTMLElement).textContent = ASK_REMOTE_CONSENT_NOTE;

  const updateLimit = () => { ui.limit.textContent = askLimitText(codePoints(ui.question.value, 2001)); };
  const clearInput = () => { ui.question.value = ''; updateLimit(); };
  updateLimit();
  // A user edit: the limit, and the REMOTE-only boundary (the controller ignores it outside REMOTE, so MOCK typing is unchanged).
  ui.question.addEventListener('input', () => { updateLimit(); controller.askQuestionEdited(); });
  // Only a user change fires `change`; the checkboxes' programmatic state below (from state) never does.
  ui.focus.addEventListener('change', () => { controller.askFocusChanged(ui.focus.checked); });
  ui.consent.addEventListener('change', () => { controller.askConsentChanged(ui.consent.checked); });
  // The Ask button (click, Enter or Space): the question and the consent box are read once and handed over; a send clears the
  // input and the consent through the next render (inputGeneration, consent), before any response. No <form> element.
  ui.submit.addEventListener('click', () => { controller.askQuestion(ui.question.value, ui.focus.checked, ui.consent.checked); });

  function renderCapability(state: ConsoleState): void {
    const capability = state.askCapability;
    const remote = capability.status === 'REMOTE';
    ui.badge.textContent = capability.status === 'MOCK' ? ASK_BADGE : remote ? ASK_REMOTE_BADGE : ASK_UNCONFIRMED_BADGE;
    ui.intro.textContent = remote ? ASK_REMOTE_HEADLINE : ASK_INTRO;
    ui.examples.hidden = remote;
    ui.disclosure.hidden = !remote;
    ui.consentRow.hidden = !remote;
    ui.disclosure.replaceChildren(...(remote && capability.disclosure ? disclosureNodes(capability.disclosure) : []));
    ui.capability.textContent = capability.status === 'LOADING' ? ASK_CAPABILITY_LOADING : capability.status === 'ERROR' ? askCapabilityErrorText(capability.failure) : '';
    const label = capability.failure?.ask?.code === 'ASK_REMOTE_POLICY_CHANGED' ? ASK_REFRESH_DISCLOSURE : ASK_RETRY_CAPABILITY;
    const nodes = capability.status === 'ERROR' && capability.failure
      ? [...failureNodes(capability.failure), button(label, 'btn btn-secondary', () => controller.retryAskCapability())]
      : [];
    rebuild(ui.capabilityAction, ui.heading, nodes);
  }

  function renderForm(state: ConsoleState): void {
    const usable = askContext(state) !== null;
    const offered = state.askCapability.status === 'MOCK' || state.askCapability.status === 'REMOTE';
    ui.form.hidden = !usable;
    ui.context.textContent = offered && !usable ? ASK_CONTEXT_REQUIRED : '';
    const item = selectedObservation(state);
    ui.focus.disabled = item === null;
    ui.focus.checked = item !== null && state.ask.useFocus;
    ui.consent.checked = state.askCapability.status === 'REMOTE' && state.ask.consent;
    ui.focusNote.replaceChildren(...(item === null ? [ASK_NO_FOCUS] : ['Selected observation: ', ...untrusted(item.summary), ' (', code(item.id), ')']));
    // A pending question keeps the focused button in place (aria-disabled) instead of removing focus with `disabled`.
    ui.submit.setAttribute('aria-disabled', String(state.ask.status === 'PENDING'));
  }

  function renderAnswer(state: ConsoleState): void {
    const ask = state.ask;
    const pending = ask.status === 'PENDING';
    ui.answer.setAttribute('aria-busy', String(pending));
    ui.status.textContent = pending ? (state.askCapability.status === 'REMOTE' ? ASK_REMOTE_PENDING : ASK_PENDING)
      : ask.status === 'READY' && ask.answer ? `${ASK_STATUS_HEADING[ask.answer.status]}: ${ask.answer.claims.length} cited claim${ask.answer.claims.length === 1 ? '' : 's'}.`
        : ask.status === 'ERROR' && ask.failure ? `No answer: ${askFailureText(ask.failure)}`
          : ask.status === 'REFUSED' && ask.refusal ? ASK_REFUSAL_TEXT[ask.refusal] : '';
    const nodes = ask.status === 'READY' && ask.answer ? answerNodes(ask.answer)
      : ask.status === 'ERROR' && ask.failure ? [...failureNodes(ask.failure), el('p', 'muted small', ASK_RETRY_HINT)] : [];
    rebuild(ui.answer, ui.heading, nodes);
  }

  return {
    render(state: ConsoleState, previous: ConsoleState | null): void {
      const capability = state.askCapability.status;
      ui.panel.hidden = !state.selection || (capability !== 'MOCK' && capability !== 'REMOTE' && capability !== 'ERROR');
      const p = previous;
      if (!p || p.ask.inputGeneration !== state.ask.inputGeneration) clearInput();
      if (!p || p.askCapability !== state.askCapability) renderCapability(state);
      if (!p || p.askCapability !== state.askCapability || p.context !== state.context || p.selection !== state.selection || p.queue !== state.queue
        || p.observationId !== state.observationId || p.ask !== state.ask) renderForm(state);
      if (!p || p.ask !== state.ask || p.askCapability !== state.askCapability) renderAnswer(state);
    },
    clear(): void {
      ui.panel.hidden = true;
      clearInput();
      ui.focus.checked = false;
      ui.consent.checked = false;
      ui.capability.textContent = ''; ui.status.textContent = ''; ui.context.textContent = '';
      ui.capabilityAction.replaceChildren(); ui.answer.replaceChildren(); ui.disclosure.replaceChildren();
    }
  };
}
