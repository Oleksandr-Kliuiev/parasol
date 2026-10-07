import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientContext } from '../packages/graph/context-mapper.ts';
import type { DbClientGraph, DbObservationRow } from '../packages/graph/context-mapper.ts';
import { executeReadTool } from '../packages/tools/gateway.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { scope, actor } from '../fixtures/gasta.ts';
import { scopeContext, assertConfinedRuntimeRole } from '../packages/graph/scope-context.ts';

// Rows shaped exactly like the select in packages/graph/prisma-context.ts, so the mapping is verified without a generated client.
const graph: DbClientGraph = {
  id: 'demo-gasta', name: 'Gasta (synthetic)',
  entities: [
    { id: 'demo-kari', kind: 'PERSON', person: { displayName: 'Kari (synthetic)', email: null }, device: null, links: [] },
    { id: 'demo-device-07', kind: 'DEVICE', person: null, device: { hostname: 'GASTA-LT-07', personId: 'demo-kari' }, links: [
      { id: 'l1', status: 'CONFIRMED', external: { externalId: 'demo-atera-agent-107', resourceType: 'agent', connection: { id: 'demo-atera-connection', system: 'atera', status: 'FIXTURE' } } },
      { id: 'l2', status: 'CONFIRMED', external: { externalId: 'demo-huntress-agent-207', resourceType: 'agent', connection: { id: 'demo-huntress-connection', system: 'huntress', status: 'FIXTURE' } } }
    ] }
  ],
  connections: [
    { id: 'demo-atera-connection', system: 'atera', status: 'FIXTURE', syncStates: [
      { resourceType: 'alert', status: 'OK', lastSyncAt: new Date('2026-10-07T07:00:00Z'), lastSuccessAt: new Date('2026-10-07T07:00:00Z'), safeErrorCode: null },
      { resourceType: 'ticket', status: 'ERROR', lastSyncAt: new Date('2026-10-07T07:05:00Z'), lastSuccessAt: null, safeErrorCode: 'VENDOR_HTTP_429' }
    ] },
    { id: 'demo-huntress-connection', system: 'huntress', status: 'FIXTURE', syncStates: [] }
  ]
};
const row = (id: string, severity: string, createdAt: string): DbObservationRow => ({
  id, eventId: `e-${id}`, entityId: 'demo-device-07', decisionRunId: `run-${id}`, domain: severity === 'CRITICAL' ? 'SECURITY' : 'OPERATIONS', severity,
  priority: severity === 'CRITICAL' ? 'URGENT' : 'NORMAL', route: 'HUMAN_REVIEW', confidence: 1, provider: 'rules', reasonCodes: ['RULES_BASELINE'],
  createdAt: new Date(createdAt), updatedAt: new Date(createdAt), status: 'OPEN', acknowledgedAt: null, resolvedAt: null, supersededById: null,
  event: { eventKey: `k-${id}`, conflictOfEventKey: null, connectionId: 'demo-atera-connection', resourceType: 'alert', externalEventId: id, revision: '1', occurredAt: new Date(createdAt),
    normalized: { kind: severity === 'CRITICAL' ? 'SECURITY_INCIDENT' : 'DISK_CAPACITY', summary: 'row summary' }, connection: { system: 'atera' } }
});

test('DB rows map to ClientContextV1 with explicit resource statuses and whole-set counts', () => {
  const rows = [row('o-old-critical', 'CRITICAL', '2026-10-01T00:00:00Z'), row('o-new-medium', 'MEDIUM', '2026-10-07T00:00:00Z')];
  const ctx = mapClientContext(scope, graph, rows, { total: 150, bySeverity: [{ severity: 'MEDIUM', count: 149 }, { severity: 'CRITICAL', count: 1 }] }, 'next-page');
  assert.equal(ctx.contractVersion, 'ClientContextV1'); assert.equal(ctx.mode, 'db'); assert.equal(ctx.completeness, 'PARTIAL');
  assert.equal(ctx.people.length, 1); assert.equal(ctx.devices.length, 1); assert.equal(ctx.links.length, 2);
  assert.equal(ctx.links[0]?.entityKind, 'DEVICE'); assert.equal(ctx.links[0]?.resourceType, 'agent');
  assert.deepEqual(ctx.observations.items.map(o => o.id), ['o-old-critical', 'o-new-medium'], 'older CRITICAL stays ahead of newer MEDIUM');
  assert.deepEqual([ctx.observations.total, ctx.observations.truncated, ctx.observations.nextCursor], [150, true, 'next-page']);
  assert.deepEqual([ctx.observations.items[0]?.status, ctx.observations.items[0]?.decisionRunId, ctx.observations.items[0]?.connectionId],
    ['OPEN', 'run-o-old-critical', 'demo-atera-connection'], 'status, applied decision and source link travel with the item');
  assert.equal(ctx.observations.counts.MEDIUM, 149); assert.equal(ctx.observations.counts.CRITICAL, 1); assert.equal(ctx.observations.counts.INFO, 0);
  const byKey = Object.fromEntries(ctx.resources.map(r => [`${r.source}/${r.resourceType}`, r]));
  // A success always writes its snapshot in the same transaction; a sync state OK without one is reported, not hidden
  assert.equal(byKey['atera/alert']?.status, 'MISSING'); assert.equal(byKey['atera/alert']?.safeErrorCode, 'SNAPSHOT_MISSING'); assert.equal(byKey['atera/alert']?.asOf, null);
  assert.equal(byKey['atera/ticket']?.status, 'ERROR'); assert.equal(byKey['atera/ticket']?.safeErrorCode, 'VENDOR_HTTP_429');
  assert.equal(byKey['huntress/incident']?.status, 'MISSING'); assert.equal(byKey['huntress/incident']?.safeErrorCode, 'SYNC_NOT_CONFIGURED');
  assert.ok(ctx.resources.every(r => r.items === null), 'no resource pretends to be an empty list');
});
test('tool gateway works unchanged on a DB-mapped context', async () => {
  const ctx = mapClientContext(scope, graph, [row('o1', 'MEDIUM', '2026-10-07T00:00:00Z')], { total: 1, bySeverity: [{ severity: 'MEDIUM', count: 1 }] }, null);
  const sinks = { audit: new MemoryAudit(), securityAudit: new MemorySecurityAudit() };
  const tickets = await executeReadTool(actor, scope, 'atera.ticket.list', async () => ctx, sinks) as { status: string; items: unknown };
  assert.equal(tickets.status, 'ERROR'); assert.equal(tickets.items, null);
  const incidents = await executeReadTool(actor, scope, 'huntress.incident.list', async () => ctx, sinks) as { status: string };
  assert.equal(incidents.status, 'MISSING');
  const full = await executeReadTool(actor, scope, 'atlas.client.get_context', async () => ctx, sinks) as typeof ctx;
  assert.equal(full.observations.items[0]?.summary, 'row summary');
});
test('scope context is derived from memberships and the identifier policy; the runtime role must be confined', () => {
  assert.deepEqual(scopeContext(actor, ['demo-gasta']), { workspaceId: 'demo-vardahei', clientIds: 'demo-gasta' });
  assert.throws(() => scopeContext(actor, ['other-client']), /SCOPE_DENIED/);
  assert.throws(() => scopeContext(actor, []), /SCOPE_DENIED/);
  assert.throws(() => scopeContext({ ...actor, memberships: [{ clientId: 'a,b', permissions: [] }] }, ['a,b']), /INVALID_SCOPE_ID/);
  const ok = { superuser: false, bypassRls: false, ownsProtectedTables: false, unprotectedTables: 0 };
  assert.doesNotThrow(() => assertConfinedRuntimeRole(ok));
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, ownsProtectedTables: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, bypassRls: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, superuser: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, unprotectedTables: 2 }), /RLS_NOT_ENABLED/);
  assert.throws(() => assertConfinedRuntimeRole(undefined), /RUNTIME_ROLE_BYPASSES_RLS/);
});
