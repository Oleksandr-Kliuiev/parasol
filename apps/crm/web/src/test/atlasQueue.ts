import type { ObservationQueue, QueueSeverity, QueueState } from '../features/parasol/observationQueueContract';
import { atlasWorkspace } from './atlasWorkspace';

/** Synthetic, already-projected BFF page; real scoped upstream projection is covered by backend tests. */
export function atlasQueue(options: {
  customerId?: string; severity?: QueueSeverity; status?: QueueState; offset?: number; count?: number; total?: number; nextCursor?: string | null;
} = {}): ObservationQueue {
  const { customerId = 'customer-one', severity = 'ALL', status = 'ACTIVE', offset = 0,
    count = 25, total = 27, nextCursor = 'opaque+first/with=value?' } = options;
  const s = atlasWorkspace(customerId).summary!;
  const itemSeverity = severity === 'ALL' || severity === 'URGENT' ? 'CRITICAL' : severity;
  return { customerId, status: 'READY', queue: {
    mode: 'db', generatedAt: '2026-10-16T10:00:00Z', retrievedAt: '2026-10-16T10:00:01Z', severity, status, total,
    severityCounts: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, [itemSeverity]: total },
    items: Array.from({ length: count }, (_, i) => ({ ...s.observationPage.items[0]!, id: `queue-${offset + i + 1}`,
      summary: `Queue record ${offset + i + 1}`, severity: itemSeverity, priority: itemSeverity === 'HIGH' || itemSeverity === 'CRITICAL' ? 'URGENT' : 'NORMAL',
      status: status === 'ACTIVE' ? 'OPEN' : status })),
    devices: s.devices, resources: s.resources, nextCursor,
  } };
}
