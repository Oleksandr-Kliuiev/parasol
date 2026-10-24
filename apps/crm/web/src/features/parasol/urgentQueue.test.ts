import { describe, expect, it } from 'vitest';
import { atlasAttention, attentionCustomerId } from '../../test/atlasAttention';
import { syntheticTask } from '../../test/atlasTask';
import { inFilter, partialCustomers, queueRows } from './urgentQueue';

describe('the cross-customer observation queue', () => {
  it('puts critical rows first, then the longest waiting, across customers', () => {
    const value = atlasAttention(); const first = value.customers![0]!;
    const second = { ...first, customerId: '33333333-3333-4333-8333-333333333333', customerName: 'Second customer',
      preview: [{ ...first.preview[2]!, id: 'older-high', occurredAt: '2020-01-01T00:00:00Z' }] };
    const rows = queueRows([first, second, value.customers![1]!]);
    expect(rows.map((r) => r.observation.severity)).toEqual(['CRITICAL', 'CRITICAL', 'HIGH', 'HIGH']);
    expect(rows[2]!.observation.id).toBe('older-high');
    expect(rows.every((r) => r.customerId !== value.customers![1]!.customerId)).toBe(true);
  });

  it('files a row by its task, and leaves rows whose tasks were not read out of both task filters', () => {
    const value = atlasAttention(); const c = value.customers![0]!;
    c.tasks = [{ observationId: c.preview[0]!.id, task: { ...syntheticTask, organizationId: attentionCustomerId }, assigneeName: 'Synthetic technician' }];
    const rows = queueRows([c]);
    expect(rows.filter((r) => inFilter(r, 'open'))).toHaveLength(2);
    expect(rows.filter((r) => inFilter(r, 'linked')).map((r) => r.link?.assigneeName)).toEqual(['Synthetic technician']);
    const unread = queueRows([{ ...c, tasks: null }]);
    expect(unread.filter((r) => inFilter(r, 'open') || inFilter(r, 'linked'))).toHaveLength(0);
    expect(unread.filter((r) => inFilter(r, 'all'))).toHaveLength(3);
  });

  it('names the customers whose urgent observations go beyond the rows read', () => {
    expect(partialCustomers(atlasAttention().customers!)).toEqual([{ customerId: attentionCustomerId, customerName: 'Synthetic attention customer', shown: 3, total: 6 }]);
  });
});
