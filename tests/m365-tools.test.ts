import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor, ClientContextV1 } from '../packages/core/contracts.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import { injectedCursorKey } from '../packages/correlation/cursor.ts';
import { decideToolCall, toolsAvailableTo } from '../packages/policy/tool-policy.ts';
import { atlasTools } from '../packages/tools/composed-registry.ts';
import { executeTool } from '../packages/tools/gateway.ts';
import { MemoryToolLedger } from '../packages/tools/ledger.ts';
import { FIXTURE_M365_CONNECTION, fixtureM365Readers, m365Tools } from '../packages/tools/m365.ts';
import { contextReaders, describeTool, stage1Tools } from '../packages/tools/registry.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { runDemo } from '../fixtures/run-demo.ts';
import { actor as demoActor } from '../fixtures/gasta.ts';

// The fixture counterpart of the S2-C tool surface (no database): ONE composed registry for discovery, policy and execution;
// Stage 1 public DTOs unchanged; the two M365 tools need context:read + m365:read on ONE membership (both/single/split with
// injected synthetic actors — the demo actor keeps its permissions); fixture readers return honest UNAVAILABLE envelopes,
// never complete-empty data or a cursor, and need an explicitly injected cursor key. Ledger outcomes as in DB mode.
const demo = await runDemo();
const ctx = async (): Promise<ClientContextV1> => demo.context;
const ws = demo.context.workspaceId; const client = demo.context.clientId;
const actor = (id: string, memberships: Actor['memberships']): Actor => ({ id, workspaceId: ws, workspacePermissions: [], memberships });
const both = actor('syn-both', [{ clientId: client, permissions: ['context:read', 'm365:read'] }]);
const single = actor('syn-single', [{ clientId: client, permissions: ['context:read'] }]);
const split = actor('syn-split', [{ clientId: client, permissions: ['context:read'] }, { clientId: 'demo-other', permissions: ['m365:read'] }]);
const huntress = demo.context.observations.items.find(o => o.source === 'huntress')!;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const now = new Date();
const window = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() - 60_000).toISOString() };
const readers = (key = true) => ({ ...contextReaders(ctx), m365: fixtureM365Readers(ctx, key ? () => injectedCursorKey('fixture-synthetic-cursor-secret-0123456789') : undefined) });

test('composed registry: Stage 1 entries first and unchanged, two frozen M365 read tools, describeTool shapes', () => {
  assert.deepEqual(atlasTools.map(t => t.name), [...stage1Tools.map(t => t.name), 'atlas.observation.get_correlation', 'microsoft365.signin.list']);
  assert.ok(Object.isFrozen(atlasTools) && atlasTools.every(t => Object.isFrozen(t)));
  for (const tool of stage1Tools) assert.deepEqual(Object.keys(describeTool(tool)), ['name', 'version', 'risk', 'sideEffect', 'permission', 'description', 'parameters']);
  for (const tool of m365Tools) {
    const d = describeTool(tool);
    assert.deepEqual([Object.keys(d), d.risk, d.sideEffect, (d as { permissions: string[] }).permissions],
      [['name', 'version', 'risk', 'sideEffect', 'permissions', 'description', 'parameters'], 0, 'NONE', ['context:read', 'm365:read']]);
  }
  assert.deepEqual(Object.keys(m365Tools[0]!.parameters), ['observationId', 'connectionId', 'from', 'to', 'limit', 'cursor']);
  assert.deepEqual(Object.keys(m365Tools[1]!.parameters), ['connectionId', 'from', 'to', 'limit', 'cursor']);
});

test('all-of on one membership: both → listed and allowed; single and split → neither listed nor allowed; the demo actor is not granted m365:read', () => {
  const names = (a: Actor) => toolsAvailableTo(a, atlasTools).map(t => t.name).filter(n => m365Tools.some(m => m.name === n));
  assert.deepEqual([names(both), names(single), names(split), names(demoActor)], [m365Tools.map(t => t.name), [], [], []]);
  assert.equal(decideToolCall(both, { workspaceId: ws, clientId: client }, 'atlas.observation.get_correlation', atlasTools).effect, 'ALLOW');
  for (const a of [single, split]) {
    assert.deepEqual(decideToolCall(a, { workspaceId: ws, clientId: client }, 'microsoft365.signin.list', atlasTools), { effect: 'DENY_TOOL', reasonCode: 'PERMISSION_DENIED' });
  }
  assert.deepEqual(decideToolCall(both, { workspaceId: ws, clientId: client }, 'microsoft365.signin.list'), { effect: 'DENY_TOOL', reasonCode: 'UNKNOWN_TOOL' },
    'the legacy default registry does not execute what the composed one advertises');
});

test('fixture readers: honest UNAVAILABLE envelopes for the synthetic fixture connection; no cursor; strict input; injected key required', async () => {
  const r = await readers().m365.correlation({ connectionId: FIXTURE_M365_CONNECTION, observationId: huntress.id, ...window });
  assert.deepEqual([r.mode, r.items, r.total, r.nextCursor, r.coverage.status, r.coverage.traversalComplete, r.resources.map(x => x.status), r.resolution.device],
    ['fixture', null, 0, null, 'UNAVAILABLE', false, ['FIXTURE', 'FIXTURE', 'FIXTURE'], 'UNRESOLVED']);
  assert.deepEqual(r.source, { eventKey: huntress.eventKey, severity: huntress.severity, priority: huntress.priority, route: huntress.route });
  const s = await readers().m365.signIns({ connectionId: FIXTURE_M365_CONNECTION, ...window });
  assert.deepEqual([s.contractVersion, s.items, s.coverage.status], ['atlas.m365-signins.v1', null, 'UNAVAILABLE']);
  await assert.rejects(readers().m365.signIns({ connectionId: 'other', ...window }), fails('CONNECTION_NOT_FOUND'));
  await assert.rejects(readers(false).m365.signIns({ connectionId: FIXTURE_M365_CONNECTION, ...window }), fails('CORRELATION_CURSOR_CONFIG_INVALID'));
  await assert.rejects(readers().m365.signIns({ connectionId: FIXTURE_M365_CONNECTION, ...window, cursor: `${'A'.repeat(10)}.${'B'.repeat(43)}` }),
    fails('CORRELATION_CURSOR_INVALID'));
  await assert.rejects(readers().m365.signIns({ connectionId: FIXTURE_M365_CONNECTION, from: window.from, to: new Date(now.getTime() + 60_000).toISOString() }),
    fails('CORRELATION_INTERVAL_FUTURE'));
  const atera = demo.context.observations.items.find(o => o.source !== 'huntress');
  if (atera) await assert.rejects(readers().m365.correlation({ connectionId: FIXTURE_M365_CONNECTION, observationId: atera.id, ...window }), fails('CORRELATION_SOURCE_UNSUPPORTED'));
});

test('gateway counterpart: allowed call SUCCEEDED, denied call audited as tool.denied, a reader without M365 support FAILED — on the same registry', async () => {
  const audit = new MemoryAudit(); const securityAudit = new MemorySecurityAudit(); const ledger = new MemoryToolLedger(audit);
  const scope = { workspaceId: ws, clientId: client };
  const ok = await executeTool(both, scope, { tool: 'microsoft365.signin.list', parameters: { connectionId: FIXTURE_M365_CONNECTION, ...window }, correlationId: 'c-ok' },
    readers(), { audit, securityAudit, ledger }, atlasTools);
  assert.equal((ok.result as { coverage: { status: string } }).coverage.status, 'UNAVAILABLE');
  await assert.rejects(executeTool(split, scope, { tool: 'microsoft365.signin.list', parameters: {}, correlationId: 'c-split' }, readers(), { audit, securityAudit, ledger },
    atlasTools), fails('TOOL_DENIED'));
  await assert.rejects(executeTool(both, scope, { tool: 'microsoft365.signin.list', parameters: { connectionId: FIXTURE_M365_CONNECTION, ...window }, correlationId: 'c-legacy' },
    contextReaders(ctx), { audit, securityAudit, ledger }, atlasTools), fails('M365_READS_UNAVAILABLE'));
  assert.deepEqual(ledger.list(scope).map(e => [e.correlationId, e.status, e.safeErrorCode]), [['c-ok', 'SUCCEEDED', null], ['c-legacy', 'FAILED', 'M365_READS_UNAVAILABLE']]);
  assert.deepEqual(audit.list(scope).filter(e => e.correlationId === 'c-split').map(e => [e.eventType, e.metadata.safeErrorCode]), [['tool.denied', 'PERMISSION_DENIED']]);
});
