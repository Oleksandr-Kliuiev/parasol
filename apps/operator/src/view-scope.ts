// Selected-client header: client label and ID, context mode and completeness, context loading/error/validated state and
// the explicit context refresh. Mode labels reflect the actual contract value; 'db' never implies LIVE or production.
import { button, el, rebuild, shortenedText } from './dom.ts';
import { COMPLETENESS_TEXT, MODE_LABEL, NOT_ATOMIC_TEXT, SCOPE_DENIED_TEXT } from './messages.ts';
import { displayText } from './validate-core.ts';
import { failureNotice, fields } from './view-parts.ts';
import type { Controller } from './controller.ts';
import type { ConsoleState } from './state.ts';

export function renderScope(panel: HTMLElement, state: ConsoleState, controller: Controller): void {
  const body: Node[] = [];
  const { selection, context } = state;
  const heading = el('h1', null);
  heading.tabIndex = -1;
  if (!selection) {
    heading.append('No client selected');
    body.push(heading);
    if (state.scopeDenied) body.push(el('p', 'notice notice-warning', SCOPE_DENIED_TEXT));
    body.push(el('p', 'muted', 'Choose a client from the list. A client is never selected automatically.'));
  } else {
    const name = displayText(context.data?.clientName ?? selection.name);
    heading.append(...shortenedText(name.text || selection.clientId, name.shortened));
    body.push(heading);
    const rows: [string, Node | string][] = [['Client ID', el('code', null, selection.clientId)]];
    if (context.data) rows.push(['Context mode', MODE_LABEL[context.data.mode]], ['Completeness', COMPLETENESS_TEXT[context.data.completeness]]);
    body.push(fields(rows, 'meta'));
    if (context.status === 'LOADING') body.push(el('p', 'panel-status', 'Loading and validating the client context…'));
    else if (context.status === 'ERROR' && context.error) {
      body.push(failureNotice(context.error), button('Retry', 'btn btn-secondary', () => controller.refreshContext()));
    } else if (context.data) {
      const generated = displayText(context.data.generatedAt, 64).text;
      body.push(el('p', 'notice notice-ok', `Client context received and validated (generated ${generated}).`),
        el('p', 'muted small', NOT_ATOMIC_TEXT), button('Refresh context', 'btn btn-small', () => controller.refreshContext()));
    }
  }
  panel.setAttribute('aria-busy', String(context.status === 'LOADING'));
  rebuild(panel, heading, body);
}
