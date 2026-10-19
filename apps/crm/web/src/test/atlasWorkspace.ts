import type { Workspace } from '../features/parasol/workspaceContract';

/** Synthetic, projected BFF response. Backend tests independently read the scoped ClientContextV1 contract fixture. */
export function atlasWorkspace(customerId = 'customer-one'): Workspace {
  return {
    customerId, status: 'READY', summary: {
      mode: 'db', generatedAt: '2026-10-16T10:00:00Z', completeness: 'PARTIAL',
      knownDevices: 42, knownPeople: 11, activeObservations: 3,
      severityCounts: { INFO: 0, LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 1 },
      resources: [
        { source: 'atera', resourceType: 'agent', status: 'STALE', asOf: '2026-10-15T10:00:00Z', lastSuccessAt: '2026-10-15T10:00:00Z', returnedItems: 25, truncated: true },
        { source: 'huntress', resourceType: 'incident', status: 'MISSING', asOf: null, lastSuccessAt: null, returnedItems: null, truncated: false },
      ],
      devices: Array.from({ length: 42 }, (_, i) => ({ id: `device-${i}`, hostname: `SYNTHETIC-LT-${String(i + 1).padStart(2, '0')}`,
        sources: i === 0 ? ['atera', 'huntress'] : [] })),
      observationPage: { truncated: false, items: [
        { id: 'critical-one', summary: 'Synthetic disk capacity used: 97%', source: 'atera', resourceType: 'alert', kind: 'DISK_CAPACITY',
          domain: 'OPERATIONS', severity: 'CRITICAL', priority: 'URGENT', route: 'MONITOR', status: 'OPEN',
          occurredAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:10:00Z', deviceStatus: 'CONFIRMED', deviceId: 'device-0' },
        { id: 'high-one', summary: 'Synthetic security incident awaiting review', source: 'huntress', resourceType: 'incident', kind: 'SECURITY_INCIDENT',
          domain: 'SECURITY', severity: 'HIGH', priority: 'URGENT', route: 'HUMAN_REVIEW', status: 'ACKNOWLEDGED',
          occurredAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:10:00Z', deviceStatus: 'UNRESOLVED', deviceId: null },
        { id: 'medium-one', summary: 'Synthetic device reference without a confirmed source link', source: 'atera', resourceType: 'alert', kind: 'DISK_CAPACITY',
          domain: 'OPERATIONS', severity: 'MEDIUM', priority: 'NORMAL', route: 'INVESTIGATE', status: 'OPEN',
          occurredAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:10:00Z', deviceStatus: 'UNAVAILABLE', deviceId: null },
      ] },
    },
  };
}
