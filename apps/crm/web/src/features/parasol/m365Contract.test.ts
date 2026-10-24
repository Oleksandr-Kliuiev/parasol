import { describe, expect, it } from 'vitest';
import { atlasM365 } from '../../test/atlasM365';
import { parseM365 } from './m365Contract';

describe('the bounded customer Microsoft 365 metadata contract', () => {
  it('retains stale counts and explicit traversal gaps without turning them into an all-clear', () => {
    const view = parseM365(atlasM365(), 'customer-one');
    expect(view.status).toBe('READY');
    expect(view.summary?.connections[0]?.directory[1]?.status).toBe('STALE');
    expect(view.summary?.connections[0]?.directory[1]?.count).toBe(10);
    expect(view.summary?.connections[0]?.signIns.gaps).toHaveLength(2);
  });

  it.each(['foreign-customer', 'private-field', 'duplicate-resource', 'duplicate-connection', 'too-many', 'negative', 'overflow',
    'missing-count', 'expired-count', 'total', 'fake-partial', 'future', 'local-time', 'wrong-window', 'unaligned-window',
    'overlap', 'outside', 'complete-with-gap', 'unavailable-with-gap', 'unknown-freshness', 'error-with-data'])('rejects %s before any display', change => {
    const value = JSON.parse(JSON.stringify(atlasM365()));
    const c = value.summary.connections[0], d = c.directory[0], si = c.signIns;
    switch (change) {
      case 'foreign-customer': value.customerId = 'foreign'; break;
      case 'private-field': c.userPrincipalName = 'synthetic-private@example.invalid'; break;
      case 'duplicate-resource': c.directory[1].resourceType = 'm365_user'; break;
      case 'duplicate-connection': value.summary.connections.push(structuredClone(c)); value.summary.totalConnections = 2; break;
      case 'too-many': for (let i = 1; i < 9; i++) value.summary.connections.push({ ...c, connectionId: `extra-${i}` }); value.summary.totalConnections = 9; value.summary.truncated = true; break;
      case 'negative': d.count = -1; break;
      case 'overflow': d.count = 20_001; break;
      case 'missing-count': d.count = null; break;
      case 'expired-count': d.status = 'MISSING'; break;
      case 'total': value.summary.totalConnections = 2; break;
      case 'fake-partial': value.summary.truncated = true; break;
      case 'future': d.asOf = '2030-01-01T00:00:00Z'; break;
      case 'local-time': value.summary.assessedAt = '2026-10-17T14:15:00+02:00'; break;
      case 'wrong-window': value.summary.windowFrom = '2026-10-16T11:00:00Z'; break;
      case 'unaligned-window': value.summary.windowFrom = '2026-10-16T12:01:00Z'; value.summary.windowTo = '2026-10-17T12:01:00Z'; break;
      case 'overlap': si.gaps[1].fromInclusive = '2026-10-16T12:30:00Z'; break;
      case 'outside': si.gaps[0].fromInclusive = '2026-10-16T11:59:00Z'; break;
      case 'complete-with-gap': si.coverage = 'COMPLETE'; break;
      case 'unavailable-with-gap': si.coverage = 'UNAVAILABLE'; break;
      case 'unknown-freshness': si.freshness = 'UNKNOWN'; break;
      case 'error-with-data': value.status = 'ACCESS_DENIED'; break;
    }
    expect(parseM365(value, 'customer-one')).toEqual({ customerId: 'customer-one', status: 'INVALID_RESPONSE', summary: null });
  });

  it('distinguishes an available zero from a missing count and admits an honestly empty active-connection list', () => {
    const value = atlasM365(); const c = value.summary!.connections[0]!;
    c.directory[0]!.count = 0;
    c.directory[1] = { resourceType: 'm365_device', status: 'MISSING', count: null, asOf: null, lastSuccessAt: null };
    expect(parseM365(value, 'customer-one').status).toBe('READY');
    value.summary!.connections = []; value.summary!.totalConnections = 0;
    expect(parseM365(value, 'customer-one').summary?.connections).toEqual([]);
  });
});
