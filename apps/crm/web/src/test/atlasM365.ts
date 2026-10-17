import type { M365View } from '../features/parasol/m365Contract';

/** Independent synthetic projected BFF metadata; no source directory DTO or sign-in record. */
export function atlasM365(customerId = 'customer-one'): M365View {
  return { customerId, status: 'READY', summary: {
    assessedAt: '2026-10-17T12:15:00Z', windowFrom: '2026-10-16T12:00:00Z', windowTo: '2026-10-17T12:00:00Z',
    totalConnections: 1, truncated: false, connections: [{ connectionId: 'synthetic-m365-connection', directory: [
      { resourceType: 'm365_user', status: 'OK', count: 14, asOf: '2026-10-17T12:10:00Z', lastSuccessAt: '2026-10-17T12:10:00Z' },
      { resourceType: 'm365_device', status: 'STALE', count: 10, asOf: '2026-10-17T10:00:00Z', lastSuccessAt: '2026-10-17T10:00:00Z' },
    ], signIns: { status: 'STALE', coverage: 'PARTIAL', freshness: 'MIXED', asOf: '2026-10-17T11:00:00Z', lastSuccessAt: '2026-10-17T12:10:00Z', gaps: [
      { fromInclusive: '2026-10-16T12:00:00Z', toExclusive: '2026-10-16T13:00:00Z' },
      { fromInclusive: '2026-10-17T11:30:00Z', toExclusive: '2026-10-17T12:00:00Z' },
    ] } }],
  } };
}
