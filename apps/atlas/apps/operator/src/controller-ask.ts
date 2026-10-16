// Ask Atlas controller (docs/stage5/ask/03 "Browser state"; ASK-REMOTE docs/stage5/ask/remote/02 "Consent and generation
// isolation"). DOM-free. Capability discovery once per connected credential after a validated client list; one deliberate
// question at a time for the current validated context. A question captures the credential epoch, scope epoch, context
// generation, queue generation, selection generation, focus-choice generation, disclosure generation, the selected
// observation (its optional focus) and its own Ask generation. Every completion — success, error, 401, 403, policy 409 —
// checks ALL of them before changing anything; abort is only a courtesy. Every hook below invalidates pending work and clears
// the answer and the question input synchronously. An answer never changes context, queue, detail, evidence or urgency state.
// REMOTE adds: the disclosure of a validated AskCapabilityV2, a manual consent per question (captured with the disclosure
// tuple at submit, before the input and consent are cleared), a REMOTE-only edit hook, and the current policy-409 path. The
// request version follows the captured capability: MOCK sends V1 exactly as accepted, REMOTE only V2 — never a downgrade.
import { UUID_V4, questionProblem } from './ask-contracts.ts';
import type { ContextView } from './contracts.ts';
import { ASK_CAPABILITY_IDLE, askIdle } from './ask-state.ts';
import type { AskFailureView, AskRefusal } from './ask-state.ts';
import { fetchAskCapability, sendAskQuestion, sendAskRemoteQuestion } from './ask-transport.ts';
import type { AskReply } from './ask-transport.ts';
import { selectedObservation } from './controller-evidence.ts';
import { PanelWork } from './panels.ts';
import type { Kernel } from './panels.ts';
import type { ConsoleState } from './state.ts';
import type { TransportResult } from './transport.ts';

export interface AskController {
  /** After a validated client list: asks for the capability once per credential epoch, never again automatically. */
  discover(): void;
  /**
   * Explicit retry/refresh after a capability failure or a current policy change (not after OFF). A refresh is a generation
   * boundary: it invalidates pending Ask work and clears answer, draft and consent, even when the same tuple comes back.
   */
  retryCapability(): void;
  /**
   * Sends `question` exactly as typed for the current validated context, with the selected observation as focus when
   * `useFocus`. Clears the previous answer first. Returns true only when a request was sent; false when refused locally,
   * not ready, or a question is already pending (a second submit sends nothing). REMOTE additionally requires
   * `acknowledged` (the consent box as the operator sees it) AND the current consent state; otherwise nothing is sent.
   */
  submit(question: string, useFocus: boolean, acknowledged?: boolean): boolean;
  /** Generation hooks of the session controller (credential, scope, context, queue, selection changes). */
  onCredential(): void;
  onScope(): void;
  onContext(): void;
  onQueue(): void;
  onSelection(): void;
  /**
   * A deliberate "Use selected observation" change by the operator: invalidates older Ask work, clears the answer and the
   * question, and keeps the new choice (true only with a selected observation). Programmatic clearing is not a call here.
   */
  focusChanged(useFocus: boolean): void;
  /**
   * A user edit of the draft. REMOTE only: invalidates older pending work, clears consent and the old answer/error and keeps
   * the newly typed draft. In every other mode (MOCK included) it changes nothing: typing never affects a MOCK question.
   */
  questionEdited(): void;
  /** REMOTE only: the operator's manual consent change for the current draft. Ignored in every other mode. */
  consentChanged(checked: boolean): void;
}

/** Failure of a completed exchange as a fixed view: transport code, or HTTP_ERROR with status and validated AskErrorV1. */
function failureOf(result: TransportResult<AskReply<unknown>>): AskFailureView | null {
  if (!result.ok) return { code: result.code, status: null, ask: null };
  return result.value.kind === 'error' ? { code: 'HTTP_ERROR', status: result.value.status, ask: result.value.error } : null;
}

/**
 * The validated context an Ask question can be asked for, or null: the current selection's READY context with a MOCK
 * capability, or a DB-mode one with a REMOTE capability and its disclosure (REMOTE answers are DB-only).
 */
export function askContext(state: ConsoleState): ContextView | null {
  const context = state.context.status === 'READY' ? state.context.data : null;
  if (!context || !state.selection || context.clientId !== state.selection.clientId) return null;
  const capability = state.askCapability;
  if (capability.status === 'MOCK') return context;
  return capability.status === 'REMOTE' && capability.disclosure !== null && context.mode === 'db' ? context : null;
}

export function createAskController(kernel: Kernel): AskController {
  const capabilityWork = new PanelWork();
  const work = new PanelWork();
  const requestId = kernel.options.askRequestId ?? (() => crypto.randomUUID());
  let contextGeneration = 0;
  let queueGeneration = 0;
  let selectionGeneration = 0;
  let focusGeneration = 0;
  let inputGeneration = 0;
  /** Changes on every capability load/refresh, credential change and current policy change: a disclosure boundary. */
  let disclosureGeneration = 0;

  /** Invalidates (and aborts) any pending question, clears the answer, the question input and consent. Capability is kept. */
  function clear(): void {
    work.reset();
    inputGeneration += 1;
    kernel.set({ ask: askIdle(inputGeneration) });
  }

  function loadCapability(): void {
    const credential = kernel.holder.epoch();
    disclosureGeneration += 1;
    const pending = capabilityWork.start();
    kernel.set({ askCapability: { status: 'LOADING', failure: null, disclosure: null } });
    void fetchAskCapability(kernel.holder, pending.signal, kernel.options).then(result => {
      if (credential !== kernel.holder.epoch() || !pending.current() || !kernel.holder.connected()) return;
      if (result.ok && result.value.kind === 'ok') {
        const value = result.value.value;
        return kernel.set({ askCapability: value === 'mock' ? { status: 'MOCK', failure: null, disclosure: null }
          : { status: 'REMOTE', failure: null, disclosure: value.disclosure } });
      }
      if (result.ok && result.value.kind === 'error' && result.value.status === 404) {
        return kernel.set({ askCapability: { status: 'OFF', failure: null, disclosure: null } });
      }
      // Any other outcome (503 ASK_REMOTE_NOT_ADMITTED included: unavailable, never OFF) is a fixed unavailable state with an
      // explicit retry. A current 401/403 is handled like every other panel's: 401 disconnects; 403 clears the whole scope and
      // refreshes the picker once. The capability stays ERROR, so that refresh never asks for it again (no loop).
      kernel.set({ askCapability: { status: 'ERROR', failure: failureOf(result), disclosure: null } });
      if (!result.ok) kernel.denied(result.code);
    });
  }

  /**
   * A CURRENT 409 ASK_REMOTE_POLICY_CHANGED: the consented disclosure is no longer the policy. Clears input, answer and consent,
   * marks Ask unavailable and offers only the explicit capability refresh. Nothing is resubmitted; the old question is gone.
   */
  function policyChanged(failure: AskFailureView, useFocus: boolean): void {
    disclosureGeneration += 1;
    capabilityWork.reset(); work.reset();
    inputGeneration += 1;
    kernel.set({ askCapability: { status: 'ERROR', failure, disclosure: null }, ask: { ...askIdle(inputGeneration, useFocus), status: 'ERROR', failure } });
  }

  function refuse(refusal: AskRefusal): false {
    work.reset();
    const { inputGeneration: kept, useFocus } = kernel.state().ask;
    kernel.set({ ask: { ...askIdle(kept, useFocus), status: 'REFUSED', refusal } });
    return false;
  }

  return Object.freeze({
    discover(): void {
      if (kernel.holder.connected() && kernel.state().askCapability.status === 'IDLE') loadCapability();
    },
    retryCapability(): void {
      if (!kernel.holder.connected() || kernel.state().askCapability.status !== 'ERROR') return;
      clear();
      loadCapability();
    },
    submit(question: string, useFocus: boolean, acknowledged = false): boolean {
      const state = kernel.state();
      if (state.ask.status === 'PENDING') return false;
      const context = askContext(state);
      if (state.session !== 'READY' || !context) return false;
      // Captured BEFORE anything is cleared: the disclosure the operator saw and their consent for exactly this draft.
      const disclosure = state.askCapability.status === 'REMOTE' ? state.askCapability.disclosure : null;
      const consented = disclosure !== null && acknowledged === true && state.ask.consent === true;
      // The previous answer is cleared before anything else; a local refusal keeps the typed text (nothing was sent).
      const problem = questionProblem(question);
      if (problem !== null) return refuse(problem);
      const focus = useFocus ? selectedObservation(state)?.id ?? null : null;
      if (useFocus && focus === null) return refuse('NO_FOCUS');
      if (disclosure !== null && !consented) return refuse('CONSENT');
      const id = requestId();
      if (typeof id !== 'string' || !UUID_V4.test(id)) return refuse('REQUEST_ID');
      const captured = { context: contextGeneration, queue: queueGeneration, selection: selectionGeneration, focus: focusGeneration,
        disclosure: disclosureGeneration, observationId: state.observationId };
      const inScope = kernel.scope();
      const pending = work.start();
      const current = () => inScope() && pending.current() && contextGeneration === captured.context && queueGeneration === captured.queue
        && selectionGeneration === captured.selection && focusGeneration === captured.focus && disclosureGeneration === captured.disclosure
        && kernel.state().observationId === captured.observationId;
      inputGeneration += 1;
      // The send clears the question and the consent; the focus choice stays as sent (no focus change, so this request remains current).
      kernel.set({ ask: { status: 'PENDING', answer: null, failure: null, refusal: null, focus, useFocus, inputGeneration, consent: false } });
      const expected = { requestId: id, workspaceId: context.workspaceId, clientId: context.clientId, sourceMode: context.mode, focusObservationId: focus };
      const request = { clientId: context.clientId, requestId: id, question, observationId: focus };
      const sending = disclosure === null
        ? sendAskQuestion(kernel.holder, request, expected, pending.signal, kernel.options)
        : sendAskRemoteQuestion(kernel.holder, { ...request, acknowledgement: { contractVersion: 'AskRemoteDisclosureV1',
          admissionId: disclosure.admissionId, policyVersion: disclosure.policyVersion, questionDataClass: 'SYNTHETIC' } },
        expected, pending.signal, kernel.options);
      void sending.then(result => {
        if (!current()) return;
        if (!result.ok && kernel.denied(result.code)) return;
        const now = kernel.state().ask;
        if (result.ok && result.value.kind === 'ok') return kernel.set({ ask: { ...now, status: 'READY', answer: result.value.value } });
        const failure = failureOf(result);
        if (disclosure !== null && failure?.ask?.code === 'ASK_REMOTE_POLICY_CHANGED') return policyChanged(failure, now.useFocus);
        kernel.set({ ask: { ...now, status: 'ERROR', failure } });
      });
      return true;
    },
    onCredential(): void {
      capabilityWork.reset();
      disclosureGeneration += 1;
      kernel.set({ askCapability: ASK_CAPABILITY_IDLE });
      clear();
    },
    onScope: clear,
    onContext(): void { contextGeneration += 1; clear(); },
    onQueue(): void { queueGeneration += 1; clear(); },
    onSelection(): void { selectionGeneration += 1; clear(); },
    focusChanged(useFocus: boolean): void {
      focusGeneration += 1;
      work.reset();
      inputGeneration += 1;
      kernel.set({ ask: askIdle(inputGeneration, useFocus === true && selectedObservation(kernel.state()) !== null) });
    },
    questionEdited(): void {
      const state = kernel.state();
      if (state.askCapability.status !== 'REMOTE') return;
      const ask = state.ask;
      if (ask.status === 'IDLE' && !ask.consent) return;
      // The draft stays (same inputGeneration); the focus choice stays (an edit is not a focus change).
      work.reset();
      kernel.set({ ask: askIdle(ask.inputGeneration, ask.useFocus) });
    },
    consentChanged(checked: boolean): void {
      const state = kernel.state();
      if (state.askCapability.status !== 'REMOTE') return;
      kernel.set({ ask: { ...state.ask, consent: checked === true } });
    }
  });
}
