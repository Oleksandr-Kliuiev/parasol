// Session/scope state machine with asynchronous isolation (docs/stage5/03_SECURITY_AND_STATE.md). DOM-free.
// Every completion — success, failure, 401, 403 — first checks the captured credential epoch, scope epoch and panel
// generation; a stale completion changes nothing, whether or not its AbortSignal was honoured. This module owns the
// session, the picker and the context; the queue and evidence controllers share its epochs and 401/403 handling.
import type { ClientSummary, FailureCode } from './contracts.ts';
import type { CredentialHolder } from './credential.ts';
import { createAskController } from './controller-ask.ts';
import { createEvidenceController } from './controller-evidence.ts';
import { createQueueController } from './controller-queue.ts';
import { PanelWork } from './panels.ts';
import type { ControllerOptions, Kernel } from './panels.ts';
import { FIRST_PAGE } from './queue-query.ts';
import { getValidated } from './transport.ts';
import { validateClients } from './validate-clients.ts';
import { validateContext } from './validate-context.ts';
import { disconnectedState, emptyScope, failed, idle, loading, ready } from './state.ts';
import type { ConsoleState, SessionNotice } from './state.ts';
import { LIMITS } from './contracts.ts';

export interface Controller {
  state(): ConsoleState;
  /** Destroys the previous credential and all data, then connects with `raw` if it is a well-formed bearer token. */
  connect(raw: string): void;
  disconnect(notice: SessionNotice): void;
  refreshClients(): void;
  search(text: string): void;
  /** Selects a client of the current validated picker list; anything else is ignored. Never automatic. */
  select(clientId: string): void;
  /** Reloads the context; clears queue, selection, evidence and cursor first, reloads the queue only after it validates. */
  refreshContext(): void;
  applyQueue(statuses: readonly unknown[], severities: readonly unknown[], limit: unknown): boolean;
  refreshQueue(): void;
  nextPage(): void;
  firstPage(): void;
  retryQueue(): void;
  selectObservation(observationId: string): void;
  /** The only way to read stored source evidence: a deliberate action for the selected observation. */
  requestEvidence(): void;
  /**
   * Ask Atlas (controller-ask.ts): one deliberate question for the current validated context; true when it was sent.
   * `acknowledged` is the REMOTE consent box as shown; MOCK ignores it.
   */
  askQuestion(question: string, useFocus: boolean, acknowledged?: boolean): boolean;
  retryAskCapability(): void;
  /** A deliberate "Use selected observation" change: a generation boundary for Ask (controller-ask.ts focusChanged). */
  askFocusChanged(useFocus: boolean): void;
  /** A user edit of the Ask draft: a REMOTE-only boundary (controller-ask.ts questionEdited); no effect in MOCK. */
  askQuestionEdited(): void;
  /** The operator's manual REMOTE consent change for the current draft (controller-ask.ts consentChanged). */
  askConsentChanged(checked: boolean): void;
}

export function createController(holder: CredentialHolder, onChange: (state: ConsoleState) => void, options: ControllerOptions = {}): Controller {
  let state: ConsoleState = disconnectedState(null);
  let scopeEpoch = 0;
  const clientsWork = new PanelWork();
  const contextWork = new PanelWork();
  /** Workspace established by the first validated context of this credential epoch. */
  let workspaceId: string | null = null;

  const set = (patch: Partial<ConsoleState>) => { state = { ...state, ...patch }; onChange(state); };
  const kernel: Kernel = {
    holder, options, state: () => state, set,
    scope() { const credential = holder.epoch(); const scope = scopeEpoch; return () => credential === holder.epoch() && scope === scopeEpoch; },
    denied
  };
  const evidence = createEvidenceController(kernel);
  const ask = createAskController(kernel);
  const queue = createQueueController(kernel, evidence, { queueChanged: () => ask.onQueue(), selectionChanged: () => ask.onSelection() });

  /** Synchronous scope reset: aborts and invalidates every context, queue, evidence and Ask request. */
  function resetScope(): void {
    contextWork.reset(); queue.reset();
    scopeEpoch += 1;
    ask.onScope();
  }
  /** Synchronous credential reset: invalidates every request of the previous credential epoch and all of its data. */
  function resetCredentialWork(): void {
    clientsWork.reset(); resetScope(); workspaceId = null;
    ask.onCredential();
  }

  function disconnect(notice: SessionNotice): void {
    resetCredentialWork();
    holder.clear();
    state = disconnectedState(notice);
    onChange(state);
  }

  function denied(code: FailureCode): boolean {
    if (code === 'UNAUTHORIZED') { disconnect('UNAUTHORIZED'); return true; }
    if (code !== 'FORBIDDEN') return false;
    // Every current 403 (context, queue or evidence) is a full scope reset plus exactly one picker refresh with the same
    // credential; no client is selected automatically.
    resetScope();
    set({ selection: null, ...emptyScope(), scopeDenied: true });
    loadClients();
    return true;
  }

  function loadClients(): void {
    if (!holder.connected()) return;
    const credential = holder.epoch();
    const pending = clientsWork.start();
    set({ clients: loading() });
    void getValidated(holder, { kind: 'clients' }, pending.signal, validateClients, options).then(result => {
      if (credential !== holder.epoch() || !pending.current()) return;
      if (!result.ok && result.code === 'UNAUTHORIZED') return disconnect('UNAUTHORIZED');
      if (!result.ok && result.code === 'FORBIDDEN') {
        // A current 403 clears the whole scope. The picker itself was refused, so there is no further refresh (no loop).
        resetScope();
        return set({ selection: null, ...emptyScope(), clients: failed('FORBIDDEN') });
      }
      if (!result.ok) return set({ clients: failed(result.code) });
      set({ session: 'READY', clients: ready(result.value) });
      // Ask Atlas capability: once per connected credential, only after a validated client list.
      ask.discover();
    });
  }

  function loadContext(): void {
    const selection = state.selection;
    if (!selection || !holder.connected()) return;
    const inScope = kernel.scope();
    const pending = contextWork.start();
    queue.reset(); ask.onContext();
    set({ context: loading(), queue: idle(), queuePosition: FIRST_PAGE, observationId: null, evidence: idle() });
    const validate = (value: unknown) => validateContext(value, selection.clientId, workspaceId);
    void getValidated(holder, { kind: 'overview', clientId: selection.clientId }, pending.signal, validate, options).then(result => {
      if (!inScope() || !pending.current()) return;
      if (!result.ok && denied(result.code)) return;
      if (!result.ok) return set({ context: failed(result.code) });
      workspaceId ??= result.value.workspaceId;
      set({ context: ready(result.value) });
      // The one queue request that follows a validated context.
      queue.load(FIRST_PAGE);
    });
  }

  return Object.freeze({
    state: () => state,
    connect(raw: string): void {
      resetCredentialWork();
      if (!holder.replace(raw)) { state = disconnectedState('TOKEN_FORMAT'); onChange(state); return; }
      state = { ...disconnectedState(null), session: 'CONNECTING' };
      loadClients();
    },
    disconnect,
    refreshClients(): void { if (state.session !== 'DISCONNECTED') loadClients(); },
    search(text: string): void { set({ search: text.slice(0, LIMITS.searchLength) }); },
    select(clientId: string): void {
      const clients: readonly ClientSummary[] = state.clients.data ?? [];
      const client = clients.find(c => c.id === clientId);
      if (state.session !== 'READY' || !client) return;
      resetScope();
      state = { ...state, selection: { clientId: client.id, name: client.name }, scopeDenied: false, ...emptyScope() };
      loadContext();
    },
    refreshContext(): void { if (state.selection) loadContext(); },
    applyQueue: (statuses: readonly unknown[], severities: readonly unknown[], limit: unknown) => queue.apply(statuses, severities, limit),
    refreshQueue: () => queue.refresh(),
    nextPage: () => queue.next(),
    firstPage: () => queue.first(),
    retryQueue: () => queue.retry(),
    selectObservation: (observationId: string) => queue.select(observationId),
    requestEvidence: () => evidence.request(),
    askQuestion: (question: string, useFocus: boolean, acknowledged?: boolean) => ask.submit(question, useFocus, acknowledged),
    retryAskCapability: () => ask.retryCapability(),
    askFocusChanged: (useFocus: boolean) => ask.focusChanged(useFocus),
    askQuestionEdited: () => ask.questionEdited(),
    askConsentChanged: (checked: boolean) => ask.consentChanged(checked)
  });
}
