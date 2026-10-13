// Controller of the measured evaluation pane (04 "Pairing and arm", "Synthetic evaluation focus choice" — EXACT transition table —
// and "The server must bind the actual values"; rs-c brief C §3). DOM-free. Every completion (PAIR, Ask, RESPONSE) compares its
// captured credential epoch, pair epoch, console-scope key and its own generation before changing anything; a stale success,
// error or finally changes nothing. Nothing here selects a choice, checks consent or submits on its own; there is no retry.
import { UUID_V4, questionProblem } from '../src/ask-contracts.ts';
import type { AskFailureView } from '../src/ask-state.ts';
import { askRemoteBody } from '../src/operations.ts';
import type { AskRemoteOperation } from '../src/operations.ts';
import type { ConsoleState } from '../src/state.ts';
import type { MeasuredHolder } from './credential-measured.ts';
import type { HandoffValues } from './eval-contracts.ts';
import { cleared, EVAL_INITIAL } from './eval-state.ts';
import type { EvalUiState } from './eval-state.ts';
import { evalAskExchange, pairExchange, respondExchange } from './eval-transport.ts';

export interface EvalController {
  state(): EvalUiState;
  /** Every accepted console state change: an external invalidation clears the form (and the pair when its basis changed). */
  observe(console: ConsoleState): void;
  /** Manual PAIR with the nonce exactly as typed (the field was cleared by the view first). */
  pair(nonce: string): void;
  /** A user edit of the draft: keeps the newly typed draft, clears choice/consent/answer/handoff, invalidates pending work. */
  questionEdited(): void;
  /** The deliberate selection of the one fixed choice: keeps draft AND choice, clears consent/answer/handoff, invalidates pending. */
  choose(): void;
  /** Manual consent change; set only for a valid current draft, deliberate choice, current pair and capability tuple. */
  consentChanged(checked: boolean, draft: string): void;
  /** Captures the exact draft/choice/consent/tuple, then clears the form; true only when a request was sent. */
  submit(draft: string, choiceShown: boolean, consentShown: boolean): boolean;
  /** Manual "Send evaluation evidence" of the CURRENT completion, once. */
  sendEvidence(): void;
  /** pagehide / bfcache restore: drop the pair and everything else. */
  pageHidden(): void;
}
export interface EvalOptions {
  /** A current 401 (evaluation Ask, PAIR or RESPONSE): disconnect globally, as every accepted current 401 does. */
  readonly onUnauthorized?: () => void;
  /** A current 403: one picker refresh (the pane itself ends the pair and requires a deliberate client reselection). */
  readonly onForbidden?: () => void;
  readonly randomUUID?: () => string; readonly wallMs?: () => number;
}
/** RESPONSE refusals after which the server has revoked (or no longer has) the pair (eval-handoff-route.ts, eval-runtime.ts). */
const PAIR_ENDING: readonly string[] = ['UNAUTHORIZED', 'SCOPE_MISMATCH', 'OWNER_REQUIRED', 'PAIR_REVOKED', 'PAIR_EXPIRED', 'PAIR_UNAVAILABLE',
  'ADMISSION_NOT_ACTIVE', 'POLICY_CHANGED', 'FIXTURE_MISMATCH', 'INTERNAL_FAILURE'];
const POLICY_STALE: readonly string[] = ['ADMISSION_NOT_ACTIVE', 'POLICY_CHANGED'];

/** The console facts a pending evaluation exchange depends on (identity of each accepted state part). */
interface ScopeKey { session: unknown; selection: unknown; context: unknown; queue: unknown; queueQuery: unknown; queuePosition: unknown; observation: unknown; capability: unknown }
const keyOf = (c: ConsoleState): ScopeKey => ({ session: c.session, selection: c.selection?.clientId ?? null, context: c.context, queue: c.queue, queueQuery: c.queueQuery,
  queuePosition: c.queuePosition, observation: c.observationId, capability: c.askCapability });
const PAIR_BASIS: readonly (keyof ScopeKey)[] = ['session', 'selection', 'capability'];

export function createEvalController(holder: MeasuredHolder, onChange: (s: EvalUiState) => void, options: EvalOptions = {}): EvalController {
  let s: EvalUiState = EVAL_INITIAL;
  let consoleState: ConsoleState | null = null;
  let key: ScopeKey | null = null;
  /** Advanced by every invalidation and every submit/pair attempt: the identity a completion must still own. */
  let generation = 0;
  let control = new AbortController();
  /** The current completion's exact exchanged values (private; never state/view), eligible for ONE manual send. */
  let handoff: { values: HandoffValues; generation: number } | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** The credential epoch the pane last observed (a change ends the pair). */
  let credentialAt = holder.epoch();
  /** The console selection / capability object a block waits to see replaced (rc2 F2). */
  let blockedOn: unknown = null;
  const uuid = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const wallMs = options.wallMs ?? (() => Date.now());
  const set = (next: EvalUiState) => { s = Object.freeze(next); onChange(s); };

  /** Invalidates pending work; `keepPair` false also ends the pair (server- and holder-side session dropped locally). */
  function invalidate(keepPair: boolean, clearDraft: boolean): void {
    generation += 1; control.abort(); control = new AbortController(); handoff = null;
    if (!keepPair) { holder.endPair(); clearTimeout(expiryTimer); }
    set(cleared(s, keepPair && s.pair !== null && holder.paired(), clearDraft));
  }
  /** Ends the pair and the pending work, keeping `visible` (the current error/refusal) on screen. */
  function endPair(visible: Partial<EvalUiState>): void { invalidate(false, true); set({ ...s, ...visible }); }
  /** rc2 F2: current 401 → disconnect; current 403 → end the pair, refresh the picker once, require a deliberate reselection. */
  function unauthorized(visible: Partial<EvalUiState>): void { endPair(visible); options.onUnauthorized?.(); }
  function forbidden(visible: Partial<EvalUiState>): void {
    endPair(visible); blockedOn = consoleState?.selection ?? null; set({ ...s, block: 'SCOPE_REFUSED' }); options.onForbidden?.();
  }
  function policyChanged(visible: Partial<EvalUiState>): void {
    endPair(visible); blockedOn = consoleState?.askCapability ?? null; set({ ...s, block: 'POLICY_CHANGED' });
  }
  const context = () => consoleState?.context.status === 'READY' ? consoleState.context.data : null;
  const disclosure = () => consoleState?.askCapability.status === 'REMOTE' ? consoleState.askCapability.disclosure : null;
  /** Every precondition of consent/submit except the draft and the boxes as shown. */
  const tupleReady = () => s.block === null && s.pair !== null && holder.paired() && disclosure() !== null && context()?.mode === 'db'
    && context()?.clientId === consoleState?.selection?.clientId && s.status !== 'PENDING';

  return {
    state: () => s,
    observe(c: ConsoleState): void {
      consoleState = c;
      // A block ends only when its cause is replaced: a deliberate reselection (403) or a fresh capability (policy change).
      if ((s.block === 'SCOPE_REFUSED' && c.selection !== blockedOn) || (s.block === 'POLICY_CHANGED' && c.askCapability !== blockedOn)) {
        blockedOn = null; set({ ...s, block: null });
      }
      const next = keyOf(c);
      const previous = key; key = next;
      if (previous === null) return;
      const changed = (Object.keys(next) as (keyof ScopeKey)[]).filter(k => next[k] !== previous[k]);
      if (changed.length === 0 && holder.epoch() === credentialAt) return;
      // Credential, client or capability/policy change: the pair's basis is gone (fresh pairing, never restoration).
      const keepPair = holder.epoch() === credentialAt && !changed.some(k => PAIR_BASIS.includes(k));
      credentialAt = holder.epoch();
      invalidate(keepPair, true);
    },
    pair(nonce: string): void {
      const ctx = context();
      if (s.block !== null) return;
      invalidate(false, true);
      if (ctx === null || disclosure() === null || !holder.connected()) { set({ ...s, pairStatus: 'ERROR', pairFailure: { code: 'HTTP_ERROR', status: null, handoff: null } }); return; }
      const mine = generation; const epoch = holder.epoch(); const signal = control.signal;
      set({ ...s, pairStatus: 'PENDING', pairFailure: null });
      void pairExchange(holder, ctx.clientId, nonce, signal).then(r => {
        if (mine !== generation || epoch !== holder.epoch()) return;
        if (!r.ok) {
          const visible = { pairStatus: 'ERROR' as const, pairFailure: r.failure };
          if (r.failure.status === 401 || r.failure.code === 'UNAUTHORIZED') return unauthorized(visible);
          if (r.failure.status === 403 || r.failure.code === 'FORBIDDEN') return forbidden(visible);
          set({ ...s, ...visible }); return;
        }
        if (!holder.adoptSession(r.sessionToken, epoch)) {
          set({ ...s, pairStatus: 'ERROR', pairFailure: { code: 'RESPONSE_INVALID', status: null, handoff: null } }); return;
        }
        generation += 1;
        set({ ...cleared(s, true, true), pairStatus: 'PAIRED', pairFailure: null, pair: r.pair });
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => { if (s.pair === r.pair) invalidate(false, true); }, Math.max(0, Date.parse(r.pair.expiresAt) - wallMs()));
        (expiryTimer as unknown as { unref?: () => void }).unref?.(); // Node test runs only: never keeps a process alive (browsers have no unref)
      });
    },
    questionEdited(): void { invalidate(true, false); },
    choose(): void {
      if (s.pair === null) return;
      invalidate(true, false);
      set({ ...s, choice: true });
    },
    consentChanged(checked: boolean, draft: string): void {
      if (!checked) { if (s.consent) set({ ...s, consent: false }); return; }
      if (!s.choice || !tupleReady() || questionProblem(draft) !== null || s.status === 'PENDING') { set({ ...s, consent: false }); return; }
      set({ ...s, consent: true });
    },
    submit(draft: string, choiceShown: boolean, consentShown: boolean): boolean {
      const ctx = context(); const ack = disclosure(); const pair = s.pair;
      if (s.status === 'PENDING') return false;
      const problem = questionProblem(draft);
      const refusal = problem ?? (!s.choice || !choiceShown ? 'NO_CHOICE' : !s.consent || !consentShown ? 'CONSENT'
        : !tupleReady() || ctx === null || ack === null || pair === null ? 'NOT_READY' : null);
      // rc2 F3: a local refusal is not an event of the 04 table — an eligible completion and its handoff stay as they are.
      if (refusal !== null) { set(s.status === 'READY' || s.status === 'ERROR' ? { ...s, refusal } : { ...s, status: 'REFUSED', refusal, answer: null, failure: null }); return false; }
      const requestId = uuid();
      if (!UUID_V4.test(requestId)) { set({ ...s, status: 'REFUSED', refusal: 'REQUEST_ID' }); return false; }
      const operation: AskRemoteOperation = { clientId: ctx!.clientId, requestId, question: draft, observationId: pair!.focus.requestedFocus,
        acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ack!.admissionId, policyVersion: ack!.policyVersion, questionDataClass: 'SYNTHETIC' } };
      const body = askRemoteBody(operation);
      if (body === null) { set({ ...s, status: 'REFUSED', refusal: 'NOT_READY' }); return false; }
      // Capture first (immutable tuple), then clear draft/choice/checkbox synchronously: this clearing never invalidates the capture.
      const request = JSON.parse(body) as Record<string, unknown>;
      generation += 1; control.abort(); control = new AbortController(); handoff = null;
      const mine = generation; const epoch = holder.epoch(); const pairEpoch = holder.pairEpoch(); const signal = control.signal; const pairId = pair!.pairId;
      set({ ...cleared(s, true, true), status: 'PENDING' });
      void evalAskExchange(holder, operation, { requestId, workspaceId: ctx!.workspaceId, clientId: ctx!.clientId, sourceMode: 'db',
        focusObservationId: pair!.focus.requestedFocus }, signal).then(r => {
        if (mine !== generation || epoch !== holder.epoch() || pairEpoch !== holder.pairEpoch()) return;
        if (!r.ok) {
          const visible = { status: 'ERROR' as const, failure: { code: r.code, status: null, ask: null } };
          if (r.code === 'UNAUTHORIZED') return unauthorized(visible);
          if (r.code === 'FORBIDDEN') return forbidden(visible);
          set({ ...s, ...visible });
          return;
        }
        const reply = r.value;
        if (reply.handoff !== null) handoff = { values: { pairId, request, ...reply.handoff }, generation: mine };
        const send = reply.handoff !== null ? 'AVAILABLE' as const : 'NONE' as const;
        if (reply.kind === 'answer') set({ ...s, status: 'READY', answer: reply.view, failure: null, send });
        else {
          const failure: AskFailureView = { code: 'HTTP_ERROR', status: reply.status, ask: reply.error };
          // A current 409 policy change: the disclosure tuple is stale — end the pair, block until a fresh capability (rc2 F2).
          if (reply.status === 409 && reply.error?.code === 'ASK_REMOTE_POLICY_CHANGED') return policyChanged({ status: 'ERROR', failure });
          // The gate refuses an absent/expired/revoked pair with 503 ASK_REMOTE_NOT_ADMITTED: the pair is gone (fresh pairing); the
          // refusal stays visible (rc2 F3).
          if (reply.error?.code === 'ASK_REMOTE_NOT_ADMITTED' && reply.handoff === null) return endPair({ status: 'ERROR', failure });
          set({ ...s, status: 'ERROR', failure, send });
        }
      });
      return true;
    },
    sendEvidence(): void {
      const h = handoff; const ctx = context();
      if (s.send !== 'AVAILABLE' || h === null || h.generation !== generation || ctx === null) return;
      handoff = null; // one send: never retried or sent again
      const mine = generation; const epoch = holder.epoch(); const pairEpoch = holder.pairEpoch();
      set({ ...s, send: 'SENDING', sendFailure: null });
      void respondExchange(holder, ctx.clientId, h.values, control.signal).then(r => {
        if (mine !== generation || epoch !== holder.epoch() || pairEpoch !== holder.pairEpoch()) return;
        if (r.ok) { set({ ...s, send: 'SENT' }); return; }
        const visible = { send: 'FAILED' as const, sendFailure: r.failure, status: s.status, answer: s.answer, failure: s.failure };
        const code = r.failure.handoff ?? '';
        // rc2 F2/F3: the server's 401/403 rules, and every refusal for which the server revoked the pair, end it here too.
        if (r.failure.status === 401 || code === 'UNAUTHORIZED') return unauthorized(visible);
        if (r.failure.status === 403 || code === 'SCOPE_MISMATCH') return forbidden(visible);
        if (POLICY_STALE.includes(code)) return policyChanged(visible);
        if (PAIR_ENDING.includes(code)) return endPair(visible);
        set({ ...s, ...visible });
      });
    },
    pageHidden(): void { invalidate(false, true); },
  };
}
