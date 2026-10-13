// Observation queue: DB filter/page-size form, one page in server order (no local re-sorting), counts for this response's
// selection, explicit first/next paging. A fixture context shows the fixed demo page with no filter or paging control.
// Rows are semantic buttons; keyboard focus survives re-renders through an ID → button map.
import { OBSERVATION_STATUSES, QUEUE_PAGE_SIZES, SEVERITIES } from './contracts.ts';
import { button, el, rebuild, untrusted } from './dom.ts';
import { COUNTS_TEXT, FIXTURE_QUEUE_TEXT, QUEUE_SELECTION_REFUSED } from './messages.ts';
import type { ObservationItem, QueuePage, QueueQuery } from './contracts.ts';
import { failureNotice, severityBadge, urgentFlag } from './view-parts.ts';
import type { Controller } from './controller.ts';
import type { ConsoleState } from './state.ts';

export interface QueueRegions { controls: HTMLElement; status: HTMLElement; body: HTMLElement; heading: HTMLElement }

function checkboxes(legend: string, values: readonly string[], checked: readonly string[]): { fieldset: HTMLFieldSetElement; boxes: HTMLInputElement[] } {
  const boxes = values.map(value => {
    const box = el('input', null);
    box.type = 'checkbox'; box.value = value; box.checked = checked.includes(value);
    return box;
  });
  return { fieldset: el('fieldset', 'filter-group', el('legend', null, legend), ...boxes.map((box, i) => el('label', 'check', box, ` ${values[i]}`))), boxes };
}

/** DB filter form, built from the applied selection. Only enum literals become checkbox values. */
function filterForm(query: QueueQuery, controller: Controller): HTMLFormElement {
  const statuses = checkboxes('Status', OBSERVATION_STATUSES, query.statuses);
  const severities = checkboxes('Severity', SEVERITIES, query.severities);
  const size = el('select', 'field field-inline');
  for (const n of QUEUE_PAGE_SIZES) { const option = el('option', null, String(n)); option.value = String(n); option.selected = n === query.limit; size.append(option); }
  const refused = el('p', 'hint', '');
  const apply = el('button', 'btn btn-secondary', 'Apply filters');
  apply.type = 'submit';
  const form = el('form', 'queue-filters', statuses.fieldset, severities.fieldset, el('label', 'field-label', 'Page size ', size), apply, refused);
  form.noValidate = true;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const ok = controller.applyQueue(statuses.boxes.filter(b => b.checked).map(b => b.value), severities.boxes.filter(b => b.checked).map(b => b.value), Number(size.value));
    refused.textContent = ok ? '' : QUEUE_SELECTION_REFUSED;
  });
  return form;
}

type Rows = Map<string, HTMLButtonElement>;

function row(rows: Rows, item: ObservationItem, selected: boolean, controller: Controller): HTMLLIElement {
  const flag = urgentFlag(item.severity);
  const node = button('', flag ? 'obs obs-urgent' : 'obs', () => controller.selectObservation(item.id));
  node.append(
    el('span', 'obs-tags', ...(flag ? [flag, ' '] : []), severityBadge(item.severity), ' ', el('span', 'tag', `Priority ${item.priority}`), ' ',
      el('span', 'tag', item.status), ' ', el('span', 'tag', `${item.source} ${item.resourceType}`)),
    el('span', 'obs-summary', ...untrusted(item.summary)),
    el('span', 'obs-time', `Occurred ${item.occurredAt}`));
  if (selected) node.setAttribute('aria-current', 'true');
  rows.set(item.id, node);
  return el('li', null, node);
}

function selectionText(state: ConsoleState, page: QueuePage): string {
  if (page.mode === 'fixture') return `${page.items.length} observation${page.items.length === 1 ? '' : 's'} on the fixed demo page.`;
  const q = state.queueQuery;
  const severities = q.severities.length === SEVERITIES.length ? 'all severities' : q.severities.join(', ');
  return `Page ${state.queuePosition.number}: ${page.items.length} observation${page.items.length === 1 ? '' : 's'} · statuses ${q.statuses.join(', ')} · ${severities} · ${q.limit} per page.`;
}

function pageBody(rows: Rows, state: ConsoleState, page: QueuePage, controller: Controller): Node[] {
  const counts = SEVERITIES.slice().reverse().map(s => `${s} ${page.counts[s]}`).join(' · ');
  const out: Node[] = [el('p', 'counts', `${counts} · total ${page.total}`), el('p', 'muted small', COUNTS_TEXT)];
  out.push(page.items.length === 0
    ? el('p', 'muted', page.mode === 'fixture' ? 'The fixed demo page has no active observations.' : 'No observations match this selection.')
    : el('ol', 'queue-list', ...page.items.map(item => row(rows, item, item.id === state.observationId, controller))));
  if (page.mode === 'db') {
    const paging = el('div', 'paging');
    if (state.queuePosition.number > 1) paging.append(button('First page', 'btn btn-small', () => controller.firstPage()));
    if (page.nextCursor !== null) paging.append(button('Next page', 'btn btn-small', () => controller.nextPage()));
    if (page.truncated) out.push(el('p', 'notice notice-info', page.nextCursor !== null ? 'More observations exist beyond this page.'
      : 'The server reports more observations than this page holds but offered no next page.'));
    if (paging.childElementCount) out.push(paging);
  }
  return out;
}

export interface QueueView { controls(state: ConsoleState): void; render(state: ConsoleState): void }

export function createQueueView(regions: QueueRegions, controller: Controller): QueueView {
  const rows: Rows = new Map();
  return {
    controls(state: ConsoleState): void {
      const context = state.context.status === 'READY' ? state.context.data : null;
      const children = !context ? [] : context.mode === 'fixture' ? [el('p', 'notice notice-info', FIXTURE_QUEUE_TEXT)] : [filterForm(state.queueQuery, controller)];
      rebuild(regions.controls, regions.heading, children);
    },
    render(state: ConsoleState): void {
      let focusedId: string | null = null;
      for (const [id, node] of rows) if (node === document.activeElement) focusedId = id;
      rows.clear();
      const { queue } = state;
      let status = '';
      let body: Node[] = [];
      if (queue.status === 'LOADING') status = 'Loading observations…';
      else if (queue.status === 'ERROR' && queue.error) {
        status = `Queue unavailable (${queue.error}).`;
        body = [failureNotice(queue.error), button('Retry queue', 'btn btn-secondary', () => controller.retryQueue())];
      } else if (queue.status === 'READY' && queue.data) {
        status = selectionText(state, queue.data);
        body = pageBody(rows, state, queue.data, controller);
      } else if (state.selection && state.context.status !== 'READY') status = 'The queue loads after the client context is validated.';
      regions.body.setAttribute('aria-busy', String(queue.status === 'LOADING'));
      regions.status.textContent = status;
      rebuild(regions.body, regions.heading, body, focusedId === null ? null : rows.get(focusedId) ?? null);
    }
  };
}
