// Client picker rendering (S5-A, unchanged behaviour): validated list, local narrowing search, at most 250 rows in server
// order, explicit limitation text. Keyboard focus survives a re-render through an ID → button map, never a data attribute.
import { byId, button, el, shortenedText } from './dom.ts';
import { FAILURE_TEXT } from './messages.ts';
import { clientLabel, pickerView } from './validate-clients.ts';
import type { Controller } from './controller.ts';
import type { ConsoleState } from './state.ts';

export interface ClientsView { render(state: ConsoleState): void; clear(): void }

export function createClientsView(controller: Controller): ClientsView {
  const ui = {
    search: byId('client-search', HTMLInputElement), refresh: byId('refresh-clients', HTMLButtonElement),
    status: byId('clients-status', HTMLElement), list: byId('client-list', HTMLUListElement)
  };
  const rows = new Map<string, HTMLButtonElement>();
  return {
    clear(): void { rows.clear(); ui.list.replaceChildren(); ui.status.replaceChildren(); ui.search.value = ''; },
    render(state: ConsoleState): void {
      let focusedId: string | null = null;
      for (const [id, node] of rows) if (node === document.activeElement) focusedId = id;
      rows.clear();
      ui.list.replaceChildren();
      ui.list.setAttribute('aria-busy', String(state.clients.status === 'LOADING'));
      ui.refresh.disabled = state.clients.status === 'LOADING';
      if (state.search === '' && ui.search.value !== '') ui.search.value = '';
      const status: (Node | string)[] = [];
      if (state.clients.status === 'LOADING') status.push('Loading clients…');
      else if (state.clients.status === 'ERROR' && state.clients.error) {
        status.push(el('span', 'error-text', FAILURE_TEXT[state.clients.error]), ' ', el('code', null, state.clients.error));
      } else if (state.clients.data) {
        const view = pickerView(state.clients.data, state.search);
        if (view.total === 0) status.push('No clients are available to this token.');
        else if (view.limited) status.push(`Showing the first ${view.rows.length} of ${view.matching} matching clients (of ${view.total}). Refine the search to reach the others.`);
        else status.push(state.search === '' ? `${view.total} client${view.total === 1 ? '' : 's'}.` : `${view.matching} of ${view.total} clients match.`);
        for (const client of view.rows) {
          const label = clientLabel(client);
          const node = button('', 'client', () => controller.select(client.id));
          node.replaceChildren(el('span', 'client-name', ...shortenedText(label.text, label.shortened)), el('span', 'client-id', client.id));
          rows.set(client.id, node);
          if (state.selection?.clientId === client.id) node.setAttribute('aria-current', 'true');
          ui.list.append(el('li', null, node));
          if (focusedId === client.id) node.focus();
        }
      }
      ui.status.replaceChildren(...status);
    }
  };
}
