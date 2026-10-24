import type { Alert, AlertPage, AlertSourceRead } from '../features/service/types';

/** A stored Atera alert of the synthetic customer o1; tests override what they are about. */
export function syntheticAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1', organizationId: 'o1', organizationName: 'Fjord IT AS', system: 'atera', kind: 'Monitoring', externalId: '920029',
    severity: 'Critical', state: 'Open', title: 'Disk almost full on SRV-01', deviceName: 'SRV-01', deviceId: null,
    createdAt: '2026-10-21T06:00:00Z', lastSeenAt: '2026-10-21T08:00:00Z', resolvedAt: null, url: null, ...overrides,
  };
}

/** Atera's latest finished alert read: complete and on time at 08:30 Oslo time on 21 October, unless a test says otherwise. */
export function alertRead(overrides: Partial<AlertSourceRead> = {}): AlertSourceRead {
  return { system: 'atera', startedAt: '2026-10-21T06:30:00Z', complete: true, late: false, ...overrides };
}

/** A page of alerts with the counts the server computes over the whole filter, and the reads it carries. */
export function alertPage(items: Alert[], nextCursor: string | null = null, totalCount = items.length, reads = [alertRead()]): AlertPage {
  return {
    items, nextCursor, totalCount,
    critical: items.filter((a) => a.severity === 'Critical').length, warning: items.filter((a) => a.severity === 'Warning').length,
    reads,
  };
}
