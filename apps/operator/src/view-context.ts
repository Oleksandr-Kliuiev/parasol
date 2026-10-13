// Bounded client context: Atera/Huntress content only — person display names, device hostnames with their stored person
// reference, confirmed links and the reviewed stored resource reads with status, freshness and truncation next to each.
// Never Person.email, financial or M365 content, facts, arbitrary fields or a source hyperlink.
import { el, untrusted } from './dom.ts';
import { personReference } from './entities.ts';
import { ENTITY_TEXT } from './messages.ts';
import type { ContextView, LinkView, StoredRead } from './contracts.ts';
import { code, readStatus, storedItems } from './view-parts.ts';
import type { ConsoleState } from './state.ts';

const SOURCE_LABEL: Record<string, string> = { atera: 'Atera', huntress: 'Huntress' };
const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source;

function entityLabel(context: ContextView, link: LinkView): (Node | string)[] {
  const people = link.entityKind === 'PERSON' ? context.people.filter(p => p.id === link.entityId) : [];
  const devices = link.entityKind === 'DEVICE' ? context.devices.filter(d => d.id === link.entityId) : [];
  if (people.length === 1) return ['person ', ...untrusted(people[0]!.displayName)];
  if (devices.length === 1) return ['device ', ...untrusted(devices[0]!.hostname)];
  return [`${link.entityKind.toLowerCase()} `, code(link.entityId), ' (not in this context)'];
}

function section(title: string, count: number, empty: string, rows: HTMLElement[]): HTMLElement {
  return el('section', 'context-section', el('h3', null, `${title} (${count})`), rows.length ? el('ul', 'plain-list', ...rows) : el('p', 'muted', empty));
}

function resource(read: StoredRead): HTMLElement {
  const title = el('h4', null, `${sourceLabel(read.source)} ${read.resourceType}`, ' · connection ', read.connectionId === null ? 'none' : code(read.connectionId));
  const parts: Node[] = [title, ...readStatus(read)];
  if (read.items !== null) {
    const summary = el('summary', null, `${read.items.length} stored item${read.items.length === 1 ? '' : 's'}`);
    parts.push(read.items.length === 0 ? storedItems(read.items)[0]! : el('details', 'stored-items', summary, ...storedItems(read.items)));
  }
  return el('article', 'resource', ...parts);
}

export function contextBody(state: ConsoleState): Node[] {
  const { context } = state;
  if (!state.selection) return [];
  if (context.status === 'LOADING') return [el('p', 'panel-status', 'Loading the client context…')];
  if (context.status === 'ERROR') return [el('p', 'muted', 'The client context is unavailable; nothing from an earlier read is shown.')];
  const data = context.data;
  if (!data) return [];
  const people = data.people.map(p => el('li', null, ...untrusted(p.displayName)));
  const devices = data.devices.map(d => {
    const ref = personReference(data, d.personId);
    const person = ref.kind === 'RESOLVED' ? ['stored person reference: ', ...untrusted(ref.person.displayName)]
      : ref.kind === 'NONE' ? ['no stored person reference'] : [ENTITY_TEXT.PERSON_UNAVAILABLE];
    return el('li', null, el('span', 'strong', ...untrusted(d.hostname)), ' — ', ...person);
  });
  const links = data.links.map(l => el('li', null, `${sourceLabel(l.system)} ${l.resourceType} `, code(l.externalId), ' → confirmed ', ...entityLabel(data, l)));
  return [
    section('People', data.people.length, 'No people in this context.', people),
    section('Devices', data.devices.length, 'No devices in this context.', devices),
    section('Confirmed Atera/Huntress links', data.links.length, 'No confirmed Atera/Huntress links in this context.', links),
    el('section', 'context-section', el('h3', null, `Stored source reads (${data.resources.length})`),
      ...(data.resources.length ? data.resources.map(resource) : [el('p', 'muted', 'No Atera/Huntress resources in this context.')]))
  ];
}
