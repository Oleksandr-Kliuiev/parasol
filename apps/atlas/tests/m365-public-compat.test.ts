import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientContext, expectedResources } from '../packages/graph/context-mapper.ts';
import type { DbClientGraph, DbObservationRow } from '../packages/graph/context-mapper.ts';
import { scope } from '../fixtures/gasta.ts';

// Stage 2 must not change the public ClientContextV1 shape. The internal ResourceType may grow m365_* names later; what is
// pinned here is the public output: top-level fields, the expected resources per source, and no M365 trace.
const graph: DbClientGraph = {
  id: 'demo-gasta', name: 'Gasta (synthetic)',
  entities: [{ id: 'dev', kind: 'DEVICE', person: null, device: { hostname: 'GASTA-LT-07', personId: null }, links: [
    { id: 'l1', status: 'CONFIRMED', external: { externalId: 'agent-1', resourceType: 'agent', connection: { id: 'huntress-c', system: 'huntress', status: 'FIXTURE' } } }] }],
  connections: [{ id: 'huntress-c', system: 'huntress', status: 'FIXTURE', syncStates: [] }],
};
const observation: DbObservationRow = {
  id: 'o1', eventId: 'e1', entityId: 'dev', decisionRunId: 'run1', domain: 'SECURITY', severity: 'CRITICAL', priority: 'URGENT', route: 'HUMAN_REVIEW', confidence: 1,
  provider: 'rules', reasonCodes: ['RULES_BASELINE'], createdAt: new Date('2026-10-07T00:00:00Z'), updatedAt: new Date('2026-10-07T00:00:00Z'), status: 'OPEN',
  acknowledgedAt: null, resolvedAt: null, supersededById: null,
  event: { eventKey: 'k1', conflictOfEventKey: null, connectionId: 'huntress-c', resourceType: 'incident', externalEventId: '9001', revision: '1',
    occurredAt: new Date('2026-10-07T00:00:00Z'), normalized: { kind: 'SECURITY_INCIDENT', summary: 's' }, connection: { system: 'huntress' } },
};

test('ClientContextV1 public shape is unchanged: same fields, only the Stage 1 expected resources, no M365 trace', () => {
  const ctx = mapClientContext(scope, graph, [observation], { total: 1, bySeverity: [{ severity: 'CRITICAL', count: 1 }] }, null);
  assert.deepEqual(Object.keys(ctx).sort(), ['clientId', 'clientName', 'completeness', 'contractVersion', 'devices', 'generatedAt', 'links', 'mode', 'observations', 'people', 'resources', 'workspaceId']);
  assert.equal(ctx.contractVersion, 'ClientContextV1');
  assert.deepEqual(Object.keys(ctx.observations).sort(), ['counts', 'items', 'nextCursor', 'total', 'truncated']);
  assert.deepEqual(Object.keys(ctx.resources[0]!).sort(), ['asOf', 'connectionId', 'items', 'lastSuccessAt', 'resourceType', 'safeErrorCode', 'source', 'status', 'truncated']);
  const reported = new Set(ctx.resources.map(r => `${r.source}/${r.resourceType}`));
  const expected = expectedResources.huntress.map(type => `huntress/${type}`); // the only connection in this graph
  assert.ok(expected.length > 0 && expected.every(key => reported.has(key)), 'every Stage 1 expected resource of the connection is still reported');
  assert.deepEqual([...reported].sort(), [...expected].sort(), 'and nothing else');
  assert.ok(![...reported].some(key => /m365|microsoft/i.test(key)), 'no M365 resource appears in the public context');
  assert.ok(!/m365|microsoft365|graph\.microsoft/i.test(JSON.stringify(ctx)), 'no M365 identifier or link in the serialized context');
  assert.deepEqual([ctx.observations.items[0]?.severity, ctx.observations.items[0]?.priority, ctx.observations.items[0]?.route], ['CRITICAL', 'URGENT', 'HUMAN_REVIEW'], 'source urgency is untouched');
});
