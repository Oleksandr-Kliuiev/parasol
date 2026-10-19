import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTicketWork } from './ticket-work.mjs';

test('fixed fixture SQL refuses arbitrary public and private ticket inputs', () => {
  const valid = { customerId: '00000000-0000-4000-8000-000000000001', ticketId: '00000000-0000-4000-8000-000000000002',
    externalId: 910002, title: 'Synthetic saved service ticket', importedAt: '2026-10-17T00:00:00.000Z' };
  assert.doesNotThrow(() => assertTicketWork(valid));
  for (const [key, value] of [['customerId', "';DELETE service.Tickets;--"], ['ticketId', 'wrong'],
    ['externalId', '910002;DELETE service.Tickets;--'], ['externalId', 1], ['title', 'unplanned'],
    ['importedAt', 'not-a-date']]) assert.throws(() => assertTicketWork({ ...valid, [key]: value }));
  assert.throws(() => assertTicketWork(null));
});
