import { runDemo } from '../../fixtures/run-demo.ts';
import type { ClientContextV1 } from '../../packages/core/contracts.ts';

// Synthetic responses for the operator console tests (S5-A). The fixture context is the accepted fixture API's own output;
// the DB-shaped context follows packages/graph/context-mapper.ts. No value here exists in any real account.

export const fixtureContext = async (): Promise<ClientContextV1> => structuredClone((await runDemo()).context);

export function dbContext(clientId = 'demo-gasta', workspaceId = 'demo-vardahei'): ClientContextV1 {
  const scope = { workspaceId, clientId };
  const at = '2026-10-10T08:00:00.000Z';
  return {
    ...scope, contractVersion: 'ClientContextV1', mode: 'db', clientName: `Client ${clientId} (synthetic)`,
    people: [{ ...scope, id: 'p-1', displayName: 'Person (synthetic)', email: 'person@example.invalid' }],
    devices: [{ ...scope, id: 'd-1', hostname: 'HOST-01', personId: 'p-1' }],
    links: [{ ...scope, connectionId: 'conn-atera', system: 'atera', resourceType: 'agent', externalId: 'agent-1', entityId: 'd-1', entityKind: 'DEVICE', status: 'CONFIRMED' }],
    observations: { items: [{ ...scope, id: 'obs-1', eventKey: 'key-1', source: 'atera', connectionId: 'conn-atera', resourceType: 'alert', externalEventId: 'alert-1',
      revision: '1', entityId: 'd-1', decisionRunId: null, kind: 'DISK_CAPACITY', domain: 'OPERATIONS', severity: 'HIGH', priority: 'URGENT', route: 'MONITOR',
      confidence: 0.4, provider: 'rules', reasonCodes: ['SOURCE_URGENCY_FLOOR'], conflictOfEventKey: null, status: 'OPEN', acknowledgedAt: null, resolvedAt: null,
      supersededById: null, summary: 'Disk usage high (synthetic)', occurredAt: at, createdAt: at, updatedAt: at }],
      counts: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 1, CRITICAL: 0 }, total: 1, truncated: false, nextCursor: null },
    resources: [
      { source: 'atera', resourceType: 'alert', connectionId: 'conn-atera', status: 'OK', asOf: at, lastSuccessAt: at, safeErrorCode: null, truncated: false,
        items: [{ source: 'atera', resourceType: 'alert', externalId: 'alert-1', title: 'Disk (synthetic)', status: 'Open', severity: 'HIGH', priority: null,
          device: { resourceType: 'agent', externalId: 'agent-1' }, occurredAt: at, updatedAt: null }] },
      { source: 'atera', resourceType: 'ticket', connectionId: 'conn-atera', status: 'MISSING', asOf: null, lastSuccessAt: null, safeErrorCode: 'SYNC_NOT_CONFIGURED',
        truncated: false, items: null },
      { source: 'huntress', resourceType: 'incident', connectionId: 'conn-huntress', status: 'STALE', asOf: at, lastSuccessAt: at, safeErrorCode: 'SNAPSHOT_STALE',
        truncated: true, items: [] }
    ],
    generatedAt: at, completeness: 'PARTIAL'
  };
}

/** A deep copy with one change applied, for negative cases. */
export function mutate<T>(value: T, change: (copy: any) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}
