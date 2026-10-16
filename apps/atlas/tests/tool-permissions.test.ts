import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import type { Actor } from '../packages/core/contracts.ts';
import { decideToolCall, toolsAvailableTo } from '../packages/policy/tool-policy.ts';
import { contextReaders, describeTool, stage1Tools } from '../packages/tools/registry.ts';
import type { ToolDefinition } from '../packages/tools/registry.ts';
import { executeTool } from '../packages/tools/gateway.ts';
import { runDemo } from '../fixtures/run-demo.ts';
import { actor as fixtureActor, scope } from '../fixtures/gasta.ts';
import { memorySinks } from './support/tool-fixtures.ts';

// Stage 2 task 2.3 without a database (fixture counterpart of tests/pg/m365-permissions.pg.test.ts): internal tool
// definitions carry `permissions` with all-of semantics on ONE client membership; Stage 1 discovery DTOs stay exact.
// The M365 tool below is a synthetic registry entry for the policy only; the real M365 tools arrive in task 2.8.
const m365Tool: ToolDefinition = Object.freeze({ ...stage1Tools[0]!, name: 'microsoft365.signin.list', description: 'synthetic all-of probe',
  permissions: Object.freeze(['context:read', 'm365:read']), run: async () => ({ probe: true }) });
const registry = [...stage1Tools, m365Tool];
const A = scope.clientId; const B = 'demo-other';
const actorWith = (memberships: Actor['memberships']): Actor => ({ ...fixtureActor, memberships });
const decide = (a: Actor, clientId: string, name = m365Tool.name) => {
  const d = decideToolCall(a, { ...scope, clientId }, name, registry); return d.effect === 'ALLOW' ? 'ALLOW' : `${d.effect}:${d.reasonCode}`;
};

test('all-of on one client: each single permission is denied, both on the same client are allowed, split clients never combine', () => {
  const contextOnly = actorWith([{ clientId: A, permissions: ['context:read'] }]);
  const m365Only = actorWith([{ clientId: A, permissions: ['m365:read'] }]);
  const both = actorWith([{ clientId: A, permissions: ['context:read', 'm365:read'] }]);
  const split = actorWith([{ clientId: A, permissions: ['context:read'] }, { clientId: B, permissions: ['m365:read'] }]);
  assert.equal(decide(contextOnly, A), 'DENY_TOOL:PERMISSION_DENIED');
  assert.equal(decide(m365Only, A), 'DENY_TOOL:PERMISSION_DENIED');
  assert.equal(decide(both, A), 'ALLOW');
  assert.deepEqual([decide(split, A), decide(split, B)], ['DENY_TOOL:PERMISSION_DENIED', 'DENY_TOOL:PERMISSION_DENIED']);
  assert.equal(decide(split, A, 'atera.ticket.list'), 'ALLOW', 'a Stage 1 tool still needs only context:read');
  // Discovery (GET /tools) obeys the same rule
  const names = (a: Actor) => toolsAvailableTo(a, registry).map(t => t.name);
  assert.ok(!names(contextOnly).includes(m365Tool.name) && !names(m365Only).includes(m365Tool.name) && !names(split).includes(m365Tool.name));
  assert.ok(names(both).includes(m365Tool.name));
  assert.deepEqual(names(split).filter(n => n !== m365Tool.name), stage1Tools.map(t => t.name));
  assert.deepEqual(names(m365Only), [], 'm365:read alone grants no Stage 1 tool either');
  assert.ok(!names(fixtureActor).includes(m365Tool.name), 'the fixture actor has no m365:read');
  // An empty permission list grants nothing (fail closed)
  const open: ToolDefinition = { ...m365Tool, name: 'microsoft365.open.probe', permissions: [] };
  assert.equal(decideToolCall(both, scope, open.name, [open]).effect, 'DENY_TOOL');
  assert.deepEqual(toolsAvailableTo(both, [open]), []);
});

test('discovery DTOs: Stage 1 tools keep the exact legacy shape with a singular permission; a newer tool lists permissions only', () => {
  for (const tool of stage1Tools) {
    const dto = describeTool(tool);
    assert.deepEqual(Object.keys(dto), ['name', 'version', 'risk', 'sideEffect', 'permission', 'description', 'parameters'], tool.name);
    assert.deepEqual(dto, { name: tool.name, version: '1', risk: 0, sideEffect: 'NONE', permission: 'context:read', description: tool.description,
      parameters: describeTool(tool).parameters });
    assert.deepEqual(tool.permissions, ['context:read']);
  }
  const dto = describeTool(m365Tool);
  assert.deepEqual(Object.keys(dto), ['name', 'version', 'risk', 'sideEffect', 'permissions', 'description', 'parameters']);
  assert.deepEqual((dto as { permissions: string[] }).permissions, ['context:read', 'm365:read']);
  assert.ok(!('permission' in dto));
});

test('the gateway executes through the injected registry and policy: allowed with both permissions, audited tool.denied otherwise', async () => {
  const demo = await runDemo(); const sinks = memorySinks(demo.audit, demo.securityAudit);
  const readers = contextReaders(async () => demo.context);
  const both = actorWith([{ clientId: A, permissions: ['context:read', 'm365:read'] }]);
  const outcome = await executeTool(both, scope, { tool: m365Tool.name, correlationId: 'req-allof-0001' }, readers, sinks, registry);
  assert.deepEqual(outcome.result, { probe: true });
  const split = actorWith([{ clientId: A, permissions: ['context:read'] }, { clientId: B, permissions: ['m365:read'] }]);
  await assert.rejects(executeTool(split, scope, { tool: m365Tool.name, correlationId: 'req-allof-0002' }, readers, sinks, registry),
    (e: unknown) => e instanceof AtlasError && e.code === 'TOOL_DENIED');
  const denied = demo.audit.list(scope).filter(a => a.correlationId === 'req-allof-0002');
  assert.deepEqual(denied.map(a => [a.eventType, a.metadata.safeErrorCode]), [['tool.denied', 'PERMISSION_DENIED']]);
  // The default registry is Stage 1 only: an unregistered M365 tool name is unknown, never executed
  await assert.rejects(executeTool(both, scope, { tool: m365Tool.name, correlationId: 'req-allof-0003' }, readers, sinks), (e: unknown) => e instanceof AtlasError && e.code === 'TOOL_DENIED');
  assert.equal(demo.audit.list(scope).find(a => a.correlationId === 'req-allof-0003')?.metadata.safeErrorCode, 'UNKNOWN_TOOL');
});
