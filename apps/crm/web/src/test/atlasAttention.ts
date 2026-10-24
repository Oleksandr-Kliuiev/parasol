import type { AtlasAttentionCustomer, AtlasAttentionView } from '../features/parasol/atlasAttentionContract';
import { atlasWorkspace } from './atlasWorkspace';

export const attentionCustomerId = '11111111-1111-4111-8111-111111111111';
export const attentionUnavailableId = '22222222-2222-4222-8222-222222222222';

/** Synthetic closed BFF projection; the real composition separately proves directory, mapping and source reads. */
export function atlasAttention(customerId = attentionCustomerId): AtlasAttentionView {
  const summary = atlasWorkspace(customerId).summary!;
  const critical = summary.observationPage.items[0]!; const high = summary.observationPage.items[1]!;
  const ready: AtlasAttentionCustomer = {
    customerId, customerName: 'Synthetic attention customer', status: 'READY', mode: 'db', generatedAt: summary.generatedAt,
    retrievedAt: '2026-10-16T10:01:00Z', completeness: 'PARTIAL', activeObservations: 9, high: 4, critical: 2,
    resources: summary.resources, preview: [critical, { ...critical, id: 'critical-two', summary: 'Synthetic second critical observation' }, high],
    devices: [summary.devices[0]!], tasks: [],
  };
  const unavailable: AtlasAttentionCustomer = {
    customerId: attentionUnavailableId, customerName: 'Synthetic unavailable customer', status: 'UNAVAILABLE', mode: null,
    generatedAt: null, retrievedAt: null, completeness: null, activeObservations: null, high: null, critical: null,
    resources: null, preview: [], devices: [], tasks: null,
  };
  return {
    status: 'PARTIAL', checkedAt: '2026-10-16T10:01:01Z',
    coverage: { visibleClients: 4, matchedCustomers: 2, selectedCustomers: 2, attemptedCustomers: 2,
      readyCustomers: 1, failedCustomers: 1, omittedCustomers: 0, unmappedClients: 1, mappingIssues: 1, limitReached: false, timedOut: false },
    totals: { activeObservations: 9, high: 4, critical: 2 }, customers: [ready, unavailable],
  };
}

/**
 * The observation queue's read of the same synthetic customers: up to ten urgent rows per customer (two critical, then
 * `shown` of its `high`), as AtlasAttentionReader.QueueLimit allows.
 */
export function atlasQueue(customerId = attentionCustomerId, { high = 4, shown = 4 } = {}): AtlasAttentionView {
  const value = atlasAttention(customerId); const c = value.customers![0]!;
  const [critical, second, highRow] = c.preview;
  c.preview = [critical!, second!, ...Array.from({ length: shown }, (_, i) => ({
    ...highRow!, id: `high-${i}`, summary: `Synthetic high observation ${i}`, occurredAt: `2026-10-1${i}T08:00:00Z`,
  }))];
  c.high = high; c.activeObservations = high + 2 + 3;
  value.totals = { activeObservations: c.activeObservations, high, critical: 2 };
  return value;
}
