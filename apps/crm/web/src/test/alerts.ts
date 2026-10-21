import type { Alert, AlertPage } from '../features/service/types';

/** A stored Atera alert of the synthetic customer o1; tests override what they are about. */
export function syntheticAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1', organizationId: 'o1', organizationName: 'Fjord IT AS', system: 'atera', kind: 'Monitoring', externalId: '920029',
    severity: 'Critical', state: 'Open', title: 'Disk almost full on SRV-01', deviceName: 'SRV-01', deviceId: null,
    createdAt: '2026-10-21T06:00:00Z', lastSeenAt: '2026-10-21T08:00:00Z', resolvedAt: null, url: null, ...overrides,
  };
}

/** A page of alerts with the counts the server computes over the whole filter. */
export function alertPage(items: Alert[], nextCursor: string | null = null, totalCount = items.length): AlertPage {
  return {
    items, nextCursor, totalCount,
    critical: items.filter((a) => a.severity === 'Critical').length, warning: items.filter((a) => a.severity === 'Warning').length,
  };
}
