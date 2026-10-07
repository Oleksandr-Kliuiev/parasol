import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import type { ClientContextV1, ObservationPage, ResourceView } from '../packages/core/contracts.ts';
import { decideToolCall, toolsAvailableTo } from '../packages/policy/tool-policy.ts';
import { describeParameters, validateParameters } from '../packages/tools/parameters.ts';
import { describeTool, stage1Tools } from '../packages/tools/registry.ts';
import type { ToolDefinition } from '../packages/tools/registry.ts';
import { executeTool, toolInputHash } from '../packages/tools/gateway.ts';
import { contextReaders } from '../packages/tools/registry.ts';
import { runDemo } from '../fixtures/run-demo.ts';
import { actor, scope } from '../fixtures/gasta.ts';
import { memorySinks, runTool } from './support/tool-fixtures.ts';

// Task 1.9 without a database: deterministic policy over authoritative data, strict runtime parameter schemas, the gateway
// order (policy → parameters → ledgered execution), the canonical input hash, and the read tools by source ID.
const writeTool: ToolDefinition = { ...stage1Tools[0]!, name: 'atera.ticket.create', risk: 2, sideEffect: 'CREATE' };
const failsWith = (code: string, parameter?: string) => (e: unknown) =>
  e instanceof AtlasError && e.code === code && (parameter === undefined || e.details.parameter === parameter);

test('policy is deterministic and uses only authoritative data: scope, name, registry, read-only, permission', () => {
  const registry = [...stage1Tools, writeTool];
  const decide = (name: string, s = scope, a = actor) => { const d = decideToolCall(a, s, name, registry); return d.effect === 'ALLOW' ? 'ALLOW' : `${d.effect}:${d.reasonCode}`; };
  assert.deepEqual([decide('atera.ticket.list'), decide('atera.ticket.list')], ['ALLOW', 'ALLOW']);
  assert.equal(decide('atera.ticket.list', { ...scope, clientId: 'other-client' }), 'DENY_SCOPE:SCOPE_DENIED');
  assert.equal(decide('Atera.Ticket.List'), 'DENY_TOOL:INVALID_TOOL_NAME');
  assert.equal(decide('atera.ticket.delete'), 'DENY_TOOL:UNKNOWN_TOOL');
  assert.equal(decide('atera.ticket.create'), 'DENY_TOOL:WRITE_TOOL_NOT_ALLOWED', 'a registered write tool is denied by policy, not only by absence');
  const noRead = { ...actor, memberships: actor.memberships.map(m => ({ ...m, permissions: ['events:ingest'] })) };
  assert.equal(decide('atera.ticket.list', scope, noRead), 'DENY_TOOL:PERMISSION_DENIED');
  assert.ok(!toolsAvailableTo(actor, registry).some(t => t.name === 'atera.ticket.create'), 'a write tool is never offered');
  assert.deepEqual(toolsAvailableTo(noRead), []);
});

test('parameter schemas are strict: declared keys, types, bounds and required ones; a violation names the parameter, never the value', () => {
  const schema = stage1Tools.find(t => t.name === 'atlas.observation.list')!.parameters;
  assert.deepEqual(validateParameters(schema, { status: ['OPEN'], limit: 5 }), { status: ['OPEN'], limit: 5 });
  assert.deepEqual(validateParameters(schema, undefined), {});
  assert.throws(() => validateParameters(schema, { risk: 0 }), failsWith('INVALID_TOOL_PARAMETERS', 'unexpected'), 'a model cannot pass risk or anything undeclared');
  assert.throws(() => validateParameters(schema, { status: ['OPEN', 'OPEN'] }), failsWith('INVALID_TOOL_PARAMETERS', 'status'));
  assert.throws(() => validateParameters(schema, { status: ['CLOSED'] }), failsWith('INVALID_TOOL_PARAMETERS', 'status'));
  assert.throws(() => validateParameters(schema, { limit: 101 }), failsWith('INVALID_TOOL_PARAMETERS', 'limit'));
  assert.throws(() => validateParameters(schema, { limit: '5' }), failsWith('INVALID_TOOL_PARAMETERS', 'limit'));
  assert.throws(() => validateParameters(schema, []), failsWith('INVALID_TOOL_PARAMETERS', 'parameters'));
  assert.throws(() => validateParameters(schema, new Date()), failsWith('INVALID_TOOL_PARAMETERS', 'parameters'));
  const get = stage1Tools.find(t => t.name === 'atera.ticket.get')!.parameters;
  assert.throws(() => validateParameters(get, {}), failsWith('INVALID_TOOL_PARAMETERS', 'ticketId'), 'required');
  assert.throws(() => validateParameters(get, { ticketId: 'x y' }), failsWith('INVALID_TOOL_PARAMETERS', 'ticketId'));
  assert.deepEqual(describeParameters(get), { ticketId: { type: 'string', required: true, description: 'Atera ticket ID', pattern: '^[\\x21-\\x7e]{1,128}$' } });
  assert.deepEqual(describeTool(stage1Tools.find(t => t.name === 'atera.ticket.get')!).risk, 0);
});

test('gateway: a rejected parameter is audited and never read or executed; an execution is ledgered with its correlation and audit rows', async () => {
  const demo = await runDemo(); const sinks = memorySinks(demo.audit, demo.securityAudit); let reads = 0;
  const readers = contextReaders(async () => { reads++; return demo.context; });
  await assert.rejects(executeTool(actor, scope, { tool: 'atera.ticket.get', parameters: { ticketId: 'a b' } }, readers, sinks), failsWith('INVALID_TOOL_PARAMETERS'));
  assert.deepEqual([reads, sinks.ledger.list(scope).length], [0, 0]);
  const rejected = demo.audit.list(scope).at(-1)!;
  assert.deepEqual([rejected.eventType, rejected.metadata.parameter, rejected.metadata.safeErrorCode], ['tool.rejected', 'ticketId', 'INVALID_TOOL_PARAMETERS']);
  const outcome = await executeTool(actor, scope, { tool: 'atera.ticket.get', parameters: { ticketId: 'demo-ticket-1' }, correlationId: 'req-12345678' }, readers, sinks);
  const view = outcome.result as ResourceView<{ id: string }>;
  assert.deepEqual([view.status, view.items?.map(i => i.id), outcome.correlationId, outcome.toolVersion], ['FIXTURE', ['demo-ticket-1'], 'req-12345678', '1']);
  const [row] = sinks.ledger.list(scope);
  assert.deepEqual([row?.status, row?.toolName, row?.riskLevel, row?.sideEffect, row?.inputHash.length, row?.id], ['SUCCEEDED', 'atera.ticket.get', 0, 'NONE', 64, outcome.executionId]);
  const trail = demo.audit.list(scope).filter(a => a.correlationId === 'req-12345678').map(a => `${a.eventType}:${a.metadata.toolExecutionId === outcome.executionId}`);
  assert.deepEqual(trail, ['tool.started:true', 'tool.succeeded:true']);
  await assert.rejects(executeTool(actor, scope, { tool: 'atlas.client.get_context' }, contextReaders(async () => ({ ...demo.context, clientId: 'wrong' })), sinks),
    failsWith('CONTEXT_SCOPE_MISMATCH'));
  assert.deepEqual(sinks.ledger.list(scope).map(r => `${r.toolName}:${r.status}:${r.safeErrorCode ?? '-'}`),
    ['atera.ticket.get:SUCCEEDED:-', 'atlas.client.get_context:FAILED:CONTEXT_SCOPE_MISMATCH']);
});

test('the input hash is canonical: key order does not matter; tool, version, client and parameters do', () => {
  const tool = { name: 'atlas.observation.list', version: '1' };
  const base = toolInputHash(scope, tool, { status: ['OPEN'], limit: 5 });
  assert.equal(toolInputHash(scope, tool, { limit: 5, status: ['OPEN'] }), base);
  assert.notEqual(toolInputHash(scope, tool, { status: ['OPEN'], limit: 6 }), base);
  assert.notEqual(toolInputHash({ ...scope, clientId: 'other-client' }, tool, { status: ['OPEN'], limit: 5 }), base);
  assert.notEqual(toolInputHash(scope, { ...tool, version: '2' }, { status: ['OPEN'], limit: 5 }), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test('read tools by source ID keep the resource status: a missing resource is not an empty list; observations list with filters', async () => {
  const demo = await runDemo(); const sinks = memorySinks(demo.audit, demo.securityAudit);
  const absent = await runTool(actor, scope, 'atera.ticket.get', async () => demo.context, sinks, { ticketId: 'no-such-ticket' }) as ResourceView;
  assert.deepEqual([absent.status, absent.items], ['FIXTURE', []], 'read, and not there');
  const dbShaped: ClientContextV1 = { ...demo.context, mode: 'db', resources: [] };
  const missing = await runTool(actor, scope, 'huntress.incident.get', async () => dbShaped, sinks, { incidentId: '9001' }) as ResourceView;
  assert.deepEqual([missing.status, missing.items, missing.safeErrorCode], ['MISSING', null, 'RESOURCE_NOT_CONFIGURED']);
  const page = await runTool(actor, scope, 'atlas.observation.list', async () => demo.context, sinks, { severity: ['CRITICAL'] }) as ObservationPage;
  assert.ok(page.items.length > 0 && page.items.every(o => o.severity === 'CRITICAL'));
  assert.deepEqual([page.total, page.counts.CRITICAL, page.nextCursor], [page.items.length, page.items.length, null]);
  await assert.rejects(runTool(actor, scope, 'atlas.observation.list', async () => demo.context, sinks, { cursor: 'abc' }), failsWith('INVALID_CURSOR'),
    'a fixture context issues no cursor and accepts none');
});
