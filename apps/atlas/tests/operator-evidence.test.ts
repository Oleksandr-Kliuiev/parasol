import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceBody } from '../apps/operator/src/operations.ts';
import { evidenceOperation, planEvidence } from '../apps/operator/src/evidence-plan.ts';
import type { EvidenceTarget } from '../apps/operator/src/evidence-plan.ts';
import { validateEvidence } from '../apps/operator/src/validate-evidence.ts';
import { validatePage } from '../apps/operator/src/validate-observations.ts';
import { validateContext } from '../apps/operator/src/validate-context.ts';
import { resolveEntity } from '../apps/operator/src/entities.ts';
import { Invalid } from '../apps/operator/src/validate-core.ts';
import { DEFAULT_QUEUE_QUERY } from '../apps/operator/src/queue-query.ts';
import type { ContextMode, ObservationItem } from '../apps/operator/src/contracts.ts';
import { parseToolRequest } from '../apps/api/src/http-boundary.ts';
import { stage1Tools } from '../packages/tools/registry.ts';
import { validateParameters } from '../packages/tools/parameters.ts';
import { observation, page, resourceView, snapshotAlert } from './support/operator-journey.ts';
import { dbContext, fixtureContext, mutate } from './support/operator-fixtures.ts';

// S5-B evidence (B2, B3, B4, B5): the allowlist decides the exact read from the validated selection only; the body is the
// accepted ToolRequest v1; a result is accepted only for the captured tuple/mode and is filtered to the exact source ID.
const WS = 'demo-vardahei';
const item = (patch: Record<string, unknown> = {}): ObservationItem =>
  validatePage(page([observation('o-1', patch)]), { workspaceId: WS, clientId: 'c-db' }, { mode: 'db', query: { ...DEFAULT_QUEUE_QUERY, statuses: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'] } }).items[0]!;
const target = (patch: Record<string, unknown> = {}, mode: ContextMode = 'db'): EvidenceTarget => {
  const plan = planEvidence(item(patch), 'c-db', mode);
  assert.equal(plan.kind, 'request');
  return (plan as { target: EvidenceTarget }).target;
};
const code = (fn: () => unknown): string => {
  try { fn(); return 'OK'; } catch (error) { assert.ok(error instanceof Invalid); return error.message; }
};
const headers = (h: Record<string, string> = {}) => new Headers(h);

test('allowlist: exact tool per source/type/mode; fixture Huntress, other types and malformed references make no request', () => {
  const tool = (patch: Record<string, unknown>, mode: ContextMode = 'db') => {
    const plan = planEvidence(item(patch), 'c-db', mode);
    return plan.kind === 'request' ? plan.target.tool : plan.reason;
  };
  assert.equal(tool({}), 'atera.alert.list'); assert.equal(tool({}, 'fixture'), 'atera.alert.list');
  assert.equal(tool({ resourceType: 'ticket' }), 'atera.ticket.get'); assert.equal(tool({ resourceType: 'ticket' }, 'fixture'), 'atera.ticket.get');
  assert.equal(tool({ source: 'huntress', resourceType: 'incident' }), 'huntress.incident.get');
  assert.equal(tool({ source: 'huntress', resourceType: 'incident' }, 'fixture'), 'FIXTURE_HUNTRESS');
  for (const patch of [{ resourceType: 'incident' }, { resourceType: 'agent' }, { source: 'poweroffice' }, { source: 'microsoft365' }, { source: 'huntress', resourceType: 'alert' }]) {
    assert.equal(tool(patch), 'UNSUPPORTED', JSON.stringify(patch));
  }
  for (const patch of [{ connectionId: 'conn atera' }, { connectionId: '-conn' }, { connectionId: '' }, { externalEventId: 'a b' }, { externalEventId: '' },
    { externalEventId: 'x'.repeat(129) }, { externalEventId: 'ålert' }, { externalEventId: 'a\nb' }]) {
    assert.equal(tool(patch), 'INVALID_REFERENCE', JSON.stringify(patch).slice(0, 60));
  }
  assert.equal(planEvidence(item(), '../x', 'db').kind, 'unavailable');
});

test('request body: exactly {version, clientId, tool, parameters, requestId}; the accepted parser and tool schema take it', () => {
  const t = target({ resourceType: 'ticket', externalEventId: 'T-7' });
  const body = evidenceBody(evidenceOperation(t, 'req-0001-abcd'))!;
  assert.equal(body, '{"version":"1","clientId":"c-db","tool":"atera.ticket.get","parameters":{"connectionId":"conn-atera","ticketId":"T-7"},"requestId":"req-0001-abcd"}');
  for (const [patch, tool, parameters] of [[{}, 'atera.alert.list', { connectionId: 'conn-atera' }],
    [{ source: 'huntress', resourceType: 'incident', connectionId: 'conn-h', externalEventId: '9001' }, 'huntress.incident.get', { connectionId: 'conn-h', incidentId: '9001' }]] as const) {
    const parsed = parseToolRequest(JSON.parse(evidenceBody(evidenceOperation(target(patch), crypto.randomUUID()))!));
    assert.deepEqual([parsed.clientId, parsed.tool, parsed.parameters], ['c-db', tool, parameters]);
    const definition = stage1Tools.find(d => d.name === tool)!;
    assert.deepEqual(validateParameters(definition.parameters, parsed.parameters), parameters, 'the registry schema accepts exactly these parameters');
  }
  for (const requestId of ['short', 'has space-0001', 'x'.repeat(65)]) assert.equal(evidenceBody(evidenceOperation(t, requestId)), null, requestId);
  assert.equal(evidenceBody({ ...evidenceOperation(t, 'req-0001-abcd'), connectionId: 'a/b' }), null);
  assert.equal(evidenceBody({ ...evidenceOperation(t, 'req-0001-abcd'), tool: 'atera.ticket.create' } as never), null, 'no tool outside the closed union');
});

test('evidence result: captured source/resource/connection and mode only; DB SnapshotItem.externalId exact filtering keeps truncation', () => {
  const alert = target({ externalEventId: 'alert-1' });
  const listed = validateEvidence(resourceView('OK', [snapshotAlert('alert-0'), snapshotAlert('alert-1'), snapshotAlert('ALERT-1'), snapshotAlert('alert-10')], { truncated: true }),
    headers(), alert, WS);
  assert.deepEqual([listed.items!.map(i => i.shape === 'snapshot' && i.externalId), listed.readCount, listed.truncated], [['alert-1'], 4, true]);
  const absent = validateEvidence(resourceView('STALE', [snapshotAlert('alert-0')], { truncated: true }), headers(), alert, WS);
  assert.deepEqual([absent.status, absent.items, absent.truncated], ['STALE', [], true], 'absent from a truncated read is empty + truncated, never nonexistent');
  for (const status of ['ERROR', 'MISSING']) {
    const unavailable = validateEvidence(resourceView(status, null), headers(), alert, WS);
    assert.deepEqual([unavailable.items, unavailable.readCount], [null, null], `${status} is unavailable, not empty`);
  }
  const cases: [string, unknown][] = [
    ['other source', resourceView('OK', [], { source: 'huntress' })], ['other resource type', resourceView('OK', [], { resourceType: 'ticket' })],
    ['other connection', resourceView('OK', [], { connectionId: 'conn-other' })], ['null connection fallback', resourceView('OK', [], { connectionId: null })],
    ['FIXTURE in db mode', resourceView('FIXTURE', [])], ['ERROR with items', resourceView('ERROR', [])], ['OK without items', resourceView('OK', null)],
    ['item of another resource', resourceView('OK', [snapshotAlert('alert-1', { resourceType: 'ticket' })])],
    ['item id coalescing', resourceView('OK', [{ ...snapshotAlert('x'), externalId: undefined, id: 'alert-1' }])],
    ['unknown item severity', resourceView('OK', [snapshotAlert('alert-1', { severity: 'SEVERE' })])], ['unknown status', resourceView('GREEN', [])]
  ];
  for (const [name, value] of cases) assert.equal(code(() => validateEvidence(value, headers(), alert, WS)), 'RESPONSE_INVALID', name);
  assert.equal(code(() => validateEvidence(resourceView('OK', Array(1001).fill(snapshotAlert('a'))), headers(), alert, WS)), 'RESPONSE_TOO_LARGE');
  const get = target({ source: 'huntress', resourceType: 'incident', connectionId: 'conn-h', externalEventId: '9001' });
  const incident = (id: string) => ({ ...snapshotAlert(id), source: 'huntress', resourceType: 'incident' });
  const view = (items: unknown[]) => resourceView('OK', items, { source: 'huntress', resourceType: 'incident', connectionId: 'conn-h' });
  assert.equal(validateEvidence(view([incident('9001')]), headers(), get, WS).items!.length, 1);
  assert.equal(code(() => validateEvidence(view([incident('9001'), incident('9002')]), headers(), get, WS)), 'RESPONSE_INVALID', 'a get result is only the selected ID');
});

test('fixture evidence: Atera alert list matched by normalized externalEventId with verified scope; facts/externalDevice never kept', async () => {
  const fixture = await fixtureContext();
  const alertItem = validatePage(fixture.observations, { workspaceId: WS, clientId: 'demo-gasta' }, { mode: 'fixture' }).items.find(o => o.resourceType === 'alert')!;
  const plan = planEvidence(alertItem, 'demo-gasta', 'fixture');
  assert.equal(plan.kind, 'request');
  const t = (plan as { target: EvidenceTarget }).target;
  const view = validateEvidence(fixture.resources[0], headers({ 'x-atlas-correlation-id': 'corr-1' }), t, WS);
  assert.deepEqual([view.status, view.items!.length, view.readCount, view.correlationId, view.executionId], ['FIXTURE', 1, 1, 'corr-1', null]);
  assert.deepEqual(Object.keys(view.items![0]!).sort(), ['externalEventId', 'kind', 'occurredAt', 'revision', 'shape', 'sourceSeverity', 'summary']);
  for (const [name, change] of [['scope', (c: any) => { c.resources[0].items[0].clientId = 'x'; }], ['connection', (c: any) => { c.resources[0].items[0].connectionId = 'x'; }],
    ['OK in fixture mode', (c: any) => { c.resources[0].status = 'OK'; }]] as [string, (c: any) => void][]) {
    assert.equal(code(() => validateEvidence(mutate(fixture, change).resources[0], headers(), t, WS)), 'RESPONSE_INVALID', name);
  }
  const ticket = { ...t, tool: 'atera.ticket.get' as const, resourceType: 'ticket' as const, sourceId: 'demo-ticket-1' };
  assert.deepEqual(validateEvidence(fixture.resources[1], headers(), ticket, WS).items, [{ shape: 'fixture-ticket', id: 'demo-ticket-1', title: 'Disk capacity follow-up (synthetic)', status: 'OPEN' }]);
});

test('diagnostic headers: only opaque bounded IDs are kept, never invented', () => {
  const t = target();
  const read = (h: Record<string, string>) => { const v = validateEvidence(resourceView('OK', []), headers(h), t, WS); return [v.correlationId, v.executionId]; };
  assert.deepEqual(read({ 'x-atlas-correlation-id': 'req-1', 'x-atlas-tool-execution-id': 'a1b2:c3.d_4-e' }), ['req-1', 'a1b2:c3.d_4-e']);
  assert.deepEqual(read({}), [null, null]);
  for (const bad of ['<script>', 'a b', 'x'.repeat(129), 'https://x.invalid/a', 'é']) assert.deepEqual(read({ 'x-atlas-correlation-id': bad, 'x-atlas-tool-execution-id': bad }), [null, null], bad);
});

test('entity display: confirmed only by exact ID, one current row and a CONFIRMED link of that kind; never by name or hostname', () => {
  const base = dbContext('c-db', WS);
  const ctx = (change: (c: any) => void = () => undefined) => validateContext(mutate(base, change), 'c-db', null);
  assert.equal(resolveEntity(ctx(), null).kind, 'UNRESOLVED');
  const device = resolveEntity(ctx(), 'd-1');
  assert.ok(device.kind === 'DEVICE' && device.device.hostname === 'HOST-01' && device.person.kind === 'RESOLVED' && device.links.length === 1);
  for (const [name, change, id] of [
    ['no such row', () => undefined, 'd-404'],
    ['duplicate device rows', (c: any) => { c.devices.push({ ...c.devices[0], hostname: 'HOST-02' }); }, 'd-1'],
    ['person and device share the ID', (c: any) => { c.people.push({ ...c.people[0], id: 'd-1' }); }, 'd-1'],
    ['no confirmed link', (c: any) => { c.links = []; }, 'd-1'],
    ['link of the other kind', (c: any) => { c.links[0].entityKind = 'PERSON'; }, 'd-1'],
    ['person without a link even though its name matches a hostname', (c: any) => { c.people[0].displayName = 'HOST-01'; }, 'p-1']
  ] as [string, (c: any) => void, string][]) assert.equal(resolveEntity(ctx(change), id).kind, 'UNAVAILABLE', name);
  const ambiguousPerson = resolveEntity(ctx(c => { c.people.push({ ...c.people[0] }); }), 'd-1');
  assert.ok(ambiguousPerson.kind === 'DEVICE' && ambiguousPerson.person.kind === 'UNAVAILABLE', 'an ambiguous stored person reference is not guessed');
});
