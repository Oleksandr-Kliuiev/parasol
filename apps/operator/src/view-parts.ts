// Shared display parts: severity/urgency, read status and freshness, the reviewed stored-item projections. Every value is
// text (dom.ts untrusted); class names are literals chosen from validated enums. Urgency is text, not colour alone.
import { URGENT_SEVERITIES } from './contracts.ts';
import type { FailureCode, Severity, StoredItem, StoredRead } from './contracts.ts';
import { el, untrusted } from './dom.ts';
import { EMPTY_READ_TEXT, FAILURE_TEXT, READ_STATUS_TEXT, TRUNCATED_READ_TEXT, urgentText } from './messages.ts';

const SEVERITY_CLASS: Record<Severity, string> = { INFO: 'sev sev-info', LOW: 'sev sev-low', MEDIUM: 'sev sev-medium', HIGH: 'sev sev-high', CRITICAL: 'sev sev-critical' };
export const isUrgent = (severity: Severity | null): boolean => severity !== null && URGENT_SEVERITIES.includes(severity);

/** Severity as text with a shape marker for urgent levels; never colour alone. */
export function severityBadge(severity: Severity): HTMLElement {
  return el('span', SEVERITY_CLASS[severity], isUrgent(severity) ? `▲ ${severity}` : severity);
}
/** The visible urgency flag for source HIGH/CRITICAL, independent of confidence, route and priority. */
export function urgentFlag(severity: Severity | null): HTMLElement | null {
  return severity !== null && isUrgent(severity) ? el('span', 'urgent-flag', urgentText(severity)) : null;
}
/** Severity badge followed by the urgency flag when it applies. */
export function severityNodes(severity: Severity): (Node | string)[] {
  const flag = urgentFlag(severity);
  return flag ? [severityBadge(severity), ' ', flag] : [severityBadge(severity)];
}

/** A definition list of label → value rows; values are text or prepared nodes. */
export function fields(rows: readonly (readonly [string, Node | string | (Node | string)[]])[], className = 'fields'): HTMLDListElement {
  const list = el('dl', className);
  for (const [label, value] of rows) list.append(el('dt', null, label), el('dd', null, ...(Array.isArray(value) ? value : [value])));
  return list;
}
/** A validated ISO time as text; null is shown as unknown, never as a guessed time. */
export const timeText = (value: string | null): string => value ?? 'unknown';
export const code = (value: string): HTMLElement => el('code', null, ...untrusted(value));

export function failureNotice(error: FailureCode): HTMLElement {
  return el('p', 'notice notice-error', FAILURE_TEXT[error], ' ', el('code', null, error));
}

/** Read status, its two independent times and truncation, as text next to the affected read. */
export function readStatus(read: Pick<StoredRead, 'status' | 'asOf' | 'lastSuccessAt' | 'truncated'>): HTMLElement[] {
  const tone = read.status === 'OK' ? 'notice-ok' : read.status === 'FIXTURE' ? 'notice-info' : 'notice-warning';
  const out: HTMLElement[] = [el('p', `notice ${tone}`, el('strong', null, read.status), ' — ', READ_STATUS_TEXT[read.status])];
  out.push(fields([['Stored read as of', timeText(read.asOf)], ['Last successful read', timeText(read.lastSuccessAt)]], 'fields fields-compact'));
  if (read.truncated) out.push(el('p', 'notice notice-warning', TRUNCATED_READ_TEXT));
  return out;
}

/** One reviewed stored item. Device references and IDs are text; nothing becomes a link or an attribute. */
export function storedItem(item: StoredItem): HTMLElement {
  if (item.shape === 'snapshot') {
    return el('article', 'item', el('p', 'item-title', ...untrusted(item.title)), fields([
      ['Source ID', code(item.externalId)], ['Source status', untrusted(item.status)],
      ['Severity', item.severity === null ? 'none stated' : severityNodes(item.severity)],
      ['Source priority', item.priority === null ? 'none stated' : untrusted(item.priority)],
      ['Device reference', item.device === null ? 'none stated' : [item.device.resourceType, ' ', code(item.device.externalId)]],
      ['Occurred', timeText(item.occurredAt)], ['Updated', timeText(item.updatedAt)]
    ]));
  }
  if (item.shape === 'fixture-event') {
    return el('article', 'item', el('p', 'item-title', ...untrusted(item.summary)), fields([
      ['Source event ID', code(item.externalEventId)], ['Revision', untrusted(item.revision)], ['Kind', item.kind],
      ['Source severity', severityNodes(item.sourceSeverity)], ['Occurred', timeText(item.occurredAt)]
    ]));
  }
  return el('article', 'item', el('p', 'item-title', ...untrusted(item.title)), fields([['Ticket ID', code(item.id)], ['Source status', untrusted(item.status)]]));
}

/** The items of a read: unavailable (null) is never shown as empty; empty success says no stored items. */
export function storedItems(items: readonly StoredItem[] | null): HTMLElement[] {
  if (items === null) return [];
  if (items.length === 0) return [el('p', 'muted', EMPTY_READ_TEXT)];
  return [el('div', 'items', ...items.map(storedItem))];
}
