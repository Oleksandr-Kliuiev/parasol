// Rendering of ConsoleState into the static skeleton of index.html. Every dynamic node is built with createElement and
// textContent (dom.ts); state never contains the credential, so nothing rendered here can reveal it. Each region is
// rebuilt only when its own state changed, so live regions are not re-announced and focus is not disturbed elsewhere.
import { selectedObservation } from './controller-evidence.ts';
import { createAskView } from './view-ask.ts';
import { byId, el, rebuild } from './dom.ts';
import { MODE_LABEL, NOTICE_TEXT, urgentText } from './messages.ts';
import { contextBody } from './view-context.ts';
import { createClientsView } from './view-clients.ts';
import { evidenceAction, observationDetail } from './view-detail.ts';
import { evidenceBody, evidenceStatus } from './view-evidence.ts';
import { createQueueView } from './view-queue.ts';
import { renderScope } from './view-scope.ts';
import { isUrgent } from './view-parts.ts';
import type { Controller } from './controller.ts';
import type { ConsoleState } from './state.ts';

export interface View { render(state: ConsoleState): void }

export function createView(controller: Controller): View {
  const ui = {
    status: byId('session-status', HTMLElement), modeBadge: byId('mode-badge', HTMLElement), disconnect: byId('disconnect', HTMLButtonElement),
    clientsPanel: byId('clients-panel', HTMLElement), connectPanel: byId('connect-panel', HTMLElement), token: byId('token', HTMLInputElement),
    search: byId('client-search', HTMLInputElement), connectNotice: byId('connect-notice', HTMLElement), scopePanel: byId('scope-panel', HTMLElement),
    workspace: byId('workspace', HTMLElement), refreshQueue: byId('refresh-queue', HTMLButtonElement),
    detailHeading: byId('detail-heading', HTMLElement), detailStatus: byId('detail-status', HTMLElement), detailBody: byId('detail-body', HTMLElement),
    evidencePanel: byId('evidence-panel', HTMLElement), evidenceHeading: byId('evidence-heading', HTMLElement),
    evidenceAction: byId('evidence-action', HTMLElement), evidenceStatus: byId('evidence-status', HTMLElement), evidenceBody: byId('evidence-body', HTMLElement),
    contextHeading: byId('context-heading', HTMLElement), contextBody: byId('context-body', HTMLElement)
  };
  const clients = createClientsView(controller);
  const queue = createQueueView({ controls: byId('queue-controls', HTMLElement), status: byId('queue-status', HTMLElement),
    body: byId('queue-body', HTMLElement), heading: byId('queue-heading', HTMLElement) }, controller);
  const ask = createAskView(controller);
  let previous: ConsoleState | null = null;
  let evidenceButton: HTMLButtonElement | null = null;

  function renderHeader(state: ConsoleState): void {
    ui.status.textContent = state.session === 'READY' ? 'Connected' : state.session === 'CONNECTING' ? 'Connecting…' : 'Not connected';
    ui.status.className = `badge badge-session badge-${state.session.toLowerCase()}`;
    const mode = state.context.data?.mode;
    ui.modeBadge.hidden = !mode;
    ui.modeBadge.textContent = mode ? MODE_LABEL[mode] : '';
    ui.disconnect.hidden = state.session === 'DISCONNECTED';
  }

  function renderDetail(state: ConsoleState): void {
    const item = selectedObservation(state);
    const context = state.context.status === 'READY' ? state.context.data : null;
    evidenceButton = null;
    if (!item || !context || !state.selection) {
      ui.detailStatus.textContent = '';
      ui.evidencePanel.hidden = true;
      ui.evidenceAction.replaceChildren();
      rebuild(ui.detailBody, ui.detailHeading, state.queue.status === 'READY' ? [el('p', 'muted', 'Select an observation in the queue to see its details.')] : []);
      return;
    }
    ui.detailStatus.textContent = `Observation selected${isUrgent(item.severity) ? `; ${urgentText(item.severity)}` : ''}.`;
    rebuild(ui.detailBody, ui.detailHeading, observationDetail(item, context));
    const action = evidenceAction(item, state.selection.clientId, context, controller);
    evidenceButton = action.button;
    ui.evidencePanel.hidden = false;
    rebuild(ui.evidenceAction, ui.evidenceHeading, action.nodes);
  }

  function renderEvidence(state: ConsoleState): void {
    const pending = state.evidence.status === 'LOADING';
    // A pending read keeps the focused button in place (aria-disabled) instead of removing focus with `disabled`.
    if (evidenceButton) evidenceButton.setAttribute('aria-disabled', String(pending));
    ui.evidenceBody.setAttribute('aria-busy', String(pending));
    ui.evidenceStatus.textContent = evidenceStatus(state.evidence);
    rebuild(ui.evidenceBody, ui.evidenceHeading, ui.evidencePanel.hidden ? [] : evidenceBody(state.evidence, controller, evidenceButton !== null));
  }

  /** Disconnected: every region is emptied (the disconnected state has no client, context, queue or evidence). */
  function clearAll(state: ConsoleState): void {
    clients.clear(); ui.scopePanel.replaceChildren(); ui.contextBody.replaceChildren();
    queue.controls(state); queue.render(state); renderDetail(state); renderEvidence(state); ask.clear();
  }

  return {
    render(state: ConsoleState): void {
      const connected = state.session !== 'DISCONNECTED';
      renderHeader(state);
      ui.connectPanel.hidden = connected;
      ui.clientsPanel.hidden = !connected;
      ui.scopePanel.hidden = !connected;
      ui.workspace.hidden = !connected || !state.selection;
      ui.connectNotice.textContent = state.notice ? NOTICE_TEXT[state.notice] : '';
      if (!connected) clearAll(state);
      else {
        const p = previous && previous.session !== 'DISCONNECTED' ? previous : null;
        if (!p || p.clients !== state.clients || p.search !== state.search || p.selection !== state.selection) clients.render(state);
        if (!p || p.selection !== state.selection || p.context !== state.context || p.scopeDenied !== state.scopeDenied) renderScope(ui.scopePanel, state, controller);
        if (!p || p.selection !== state.selection || p.context !== state.context) {
          queue.controls(state);
          rebuild(ui.contextBody, ui.contextHeading, contextBody(state));
        }
        ui.refreshQueue.hidden = state.context.status !== 'READY';
        const queueChanged = !p || p.queue !== state.queue || p.observationId !== state.observationId || p.queuePosition !== state.queuePosition || p.context !== state.context;
        if (queueChanged) queue.render(state);
        if (queueChanged || p.selection !== state.selection) renderDetail(state);
        if (queueChanged || p.selection !== state.selection || p.evidence !== state.evidence) renderEvidence(state);
        ask.render(state, p);
      }
      if (previous && previous.session !== state.session) {
        if (state.session === 'DISCONNECTED') ui.token.focus();
        else if (state.session === 'READY' && document.activeElement === document.body) ui.search.focus();
      }
      previous = state;
    }
  };
}
