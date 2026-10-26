import type { AtlasAttentionCustomer } from './atlasAttentionContract';
import type { ObservationTaskLink } from './observationTaskContract';
import type { AtlasDevice, AtlasObservation } from './technicalContract';

/** One urgent observation of one customer in the cross-customer queue (UX 2026, В1). */
export interface QueueRow {
  key: string;
  customerId: string;
  customerName: string;
  observation: AtlasObservation;
  devices: AtlasDevice[];
  /** The task it already has; undefined when it has none, or when its customer's tasks were not read (`tasksRead`). */
  link: ObservationTaskLink | undefined;
  tasksRead: boolean;
}

/** "open": urgent and nobody's task yet, the queue's default; "linked": already has a task; "all": every row read. */
export type QueueFilter = 'open' | 'linked' | 'all';

const rank: Record<string, number> = { CRITICAL: 2, HIGH: 1 };

/**
 * The urgent rows of every customer read, in one order: critical first, then the longest waiting, so what has waited
 * longest leads (as an incident queue sorts). A customer that could not be read adds no rows; it is named apart.
 */
export function queueRows(customers: readonly AtlasAttentionCustomer[]): QueueRow[] {
  return customers.filter((c) => c.status === 'READY').flatMap((c) => {
    const links = new Map(c.tasks?.map((link) => [link.observationId, { task: link.task, assigneeName: link.assigneeName }]));
    return c.preview.map((observation) => ({
      key: `${c.customerId}:${observation.id}`, customerId: c.customerId, customerName: c.customerName,
      observation, devices: c.devices, link: links.get(observation.id), tasksRead: c.tasks !== null,
    }));
  }).sort((a, b) => (rank[b.observation.severity] ?? 0) - (rank[a.observation.severity] ?? 0)
    || Date.parse(a.observation.occurredAt) - Date.parse(b.observation.occurredAt) || a.key.localeCompare(b.key));
}

/** Whether a row belongs under a filter. A row whose tasks were not read is only under "all": its work is unknown. */
export function inFilter(row: QueueRow, filter: QueueFilter): boolean {
  if (filter === 'all') return true;
  if (!row.tasksRead) return false;
  return filter === 'linked' ? row.link !== undefined : row.link === undefined;
}

/** Customers with more urgent observations than the read shows: the queue says "N of M" and links to their own queue. */
export function partialCustomers(customers: readonly AtlasAttentionCustomer[]) {
  return customers.filter((c) => c.status === 'READY' && c.preview.length < (c.high ?? 0) + (c.critical ?? 0))
    .map((c) => ({ customerId: c.customerId, customerName: c.customerName, shown: c.preview.length, total: (c.high ?? 0) + (c.critical ?? 0) }));
}
