import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClientContext } from '../packages/graph/context-mapper.ts';
import type { DbClientGraph, DbObservationRow } from '../packages/graph/context-mapper.ts';
import { memorySinks, runTool } from './support/tool-fixtures.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { scope, actor } from '../fixtures/gasta.ts';
import { scopeContext, assertConfinedRuntimeRole } from '../packages/graph/scope-context.ts';
import { FENCE_SHARED_INVOKER_ROUTINES } from '../packages/graph/fence-role.ts';
import { readFile } from 'node:fs/promises';

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
  const sinks = memorySinks();
  const tickets = await runTool(actor, scope, 'atera.ticket.list', async () => ctx, sinks) as { status: string; items: unknown };
  assert.equal(tickets.status, 'ERROR'); assert.equal(tickets.items, null);
  const incidents = await runTool(actor, scope, 'huntress.incident.list', async () => ctx, sinks) as { status: string };
  assert.equal(incidents.status, 'MISSING');
  const full = await runTool(actor, scope, 'atlas.client.get_context', async () => ctx, sinks) as typeof ctx;
  assert.equal(full.observations.items[0]?.summary, 'row summary');
});
test('scope context is derived from memberships and the identifier policy; the runtime role must be confined', () => {
  assert.deepEqual(scopeContext(actor, ['demo-gasta']), { workspaceId: 'demo-vardahei', clientIds: 'demo-gasta' });
  assert.throws(() => scopeContext(actor, ['other-client']), /SCOPE_DENIED/);
  assert.throws(() => scopeContext(actor, []), /SCOPE_DENIED/);
  assert.throws(() => scopeContext({ ...actor, memberships: [{ clientId: 'a,b', permissions: [] }] }, ['a,b']), /INVALID_SCOPE_ID/);
  const ok = { superuser: false, bypassRls: false, ownsProtectedTables: false, unprotectedTables: 0,
    sessionRoleMismatch: false, runtimeAttributeViolations: 0, runtimeMemberships: 0,
    cleanupRoutines: 1, runtimeCanExecuteCleanup: false, deletableTables: 0, unguardedUpdateColumns: 0, missingUpdateColumns: 0, cleanupOwnerViolations: 0, cleanupOwnerMissingGrants: 0,
    cleanupExecuteViolations: 0, actionFenceFunctions: 1, actionFenceFunctionViolations: 0, actionFenceOwnerViolations: 0, actionFenceMissingGrants: 0, actionFenceRoutineViolations: 0,
    actionPolicyViolations: 0, actionTriggerViolations: 0, actionRuntimeGrantViolations: 0, actionRuntimeMissingGrants: 0,
    poTableViolations: 0, poPolicyViolations: 0, poTriggerViolations: 0, poRoutineViolations: 0, poOwnerViolations: 0, poOwnerMissingGrants: 0,
    poExecuteViolations: 0, poRuntimeGrantViolations: 0, poRuntimeMissingGrants: 0,
    arTableViolations: 0, arTriggerViolations: 0, arRoutineViolations: 0, arOwnerViolations: 0, arOwnerMissingGrants: 0,
    arExecuteViolations: 0, arRuntimeGrantViolations: 0, arRuntimeMissingGrants: 0,
    rvTableViolations: 0, rvTriggerViolations: 0, rvRoutineViolations: 0, rvDefinerViolations: 0, rvDefinerMissingGrants: 0,
    rvReaderViolations: 0, rvExecuteViolations: 0, rvRuntimeViolations: 0 };
  assert.doesNotThrow(() => assertConfinedRuntimeRole(ok));
  // Stage 2 provisioning facts fail closed (an upgrade stays stopped until prisma/roles.sql ran again)
  for (const broken of [{ cleanupRoutines: 0 }, { runtimeCanExecuteCleanup: true }, { deletableTables: 1 }, { unguardedUpdateColumns: 3 }, { missingUpdateColumns: 1 }, { cleanupOwnerViolations: 1 },
    { cleanupOwnerMissingGrants: 1 }, { cleanupExecuteViolations: 1 }, { sessionRoleMismatch: true }, { runtimeAttributeViolations: 1 },
    { runtimeMemberships: 1 },
    // Stage 3 action fence surface (fence-role.ts): incomplete provisioning or broad default grants also refuse startup
    { actionFenceFunctions: 0 }, { actionFenceFunctionViolations: 1 }, { actionFenceOwnerViolations: 1 }, { actionFenceMissingGrants: 1 }, { actionFenceRoutineViolations: 1 },
    { actionPolicyViolations: 1 }, { actionTriggerViolations: 1 }, { actionRuntimeGrantViolations: 1 }, { actionRuntimeMissingGrants: 1 },
    // Stage 4 PowerOffice surface (poweroffice-role.ts): every fact fails closed as well
    { poTableViolations: 1 }, { poPolicyViolations: 1 }, { poTriggerViolations: 1 }, { poRoutineViolations: 1 }, { poOwnerViolations: 1 },
    { poOwnerMissingGrants: 1 }, { poExecuteViolations: 1 }, { poRuntimeGrantViolations: 1 }, { poRuntimeMissingGrants: 1 },
    // Stage 5 ASK-REMOTE R-A surface (ask-remote-role.ts): every fact fails closed in every Ask mode
    { arTableViolations: 1 }, { arTriggerViolations: 1 }, { arRoutineViolations: 1 }, { arOwnerViolations: 1 }, { arOwnerMissingGrants: 1 },
    { arExecuteViolations: 1 }, { arRuntimeGrantViolations: 1 }, { arRuntimeMissingGrants: 1 },
    // R-EVAL RS-A surface (reval-role.ts): every fact fails closed in every Ask mode
    { rvTableViolations: 1 }, { rvTriggerViolations: 1 }, { rvRoutineViolations: 1 }, { rvDefinerViolations: 1 }, { rvDefinerMissingGrants: 1 },
    { rvReaderViolations: 1 }, { rvExecuteViolations: 1 }, { rvRuntimeViolations: 1 }]) {
    assert.throws(() => assertConfinedRuntimeRole({ ...ok, ...broken }), /RUNTIME_ROLE_NOT_CONFINED/, JSON.stringify(broken));
  }
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, ownsProtectedTables: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, bypassRls: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, superuser: true }), /RUNTIME_ROLE_BYPASSES_RLS/);
  assert.throws(() => assertConfinedRuntimeRole({ ...ok, unprotectedTables: 2 }), /RLS_NOT_ENABLED/);
  assert.throws(() => assertConfinedRuntimeRole(undefined), /RUNTIME_ROLE_BYPASSES_RLS/);
});

test('the fence definer\'s explicit shared-routine list is identical in prisma/roles.sql (provisioning) and the readiness check', async () => {
  const sql = await readFile(new URL('../prisma/roles.sql', import.meta.url), 'utf8');
  const block = /v_fence_shared TEXT\[\] := ARRAY\[([^\]]*)\];/.exec(sql)?.[1];
  assert.ok(block, 'roles.sql declares the list');
  assert.deepEqual([...block.matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), [...FENCE_SHARED_INVOKER_ROUTINES].sort());
  assert.ok(FENCE_SHARED_INVOKER_ROUTINES.every(r => /^public\.atlas_[a-z0-9_]+\(/.test(r)), 'every allowance names schema public');
  assert.ok(!FENCE_SHARED_INVOKER_ROUTINES.some(r => r.startsWith('public.atlas_action_') || r.startsWith('public.atlas_m365_cleanup')),
    'no Stage 3 routine, no SECURITY DEFINER cleanup routine');
});
