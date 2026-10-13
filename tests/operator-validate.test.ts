import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateClients, pickerView, clientLabel } from '../apps/operator/src/validate-clients.ts';
import { validateContext } from '../apps/operator/src/validate-context.ts';
import { Invalid, displayText } from '../apps/operator/src/validate-core.ts';
import { dbContext, fixtureContext, mutate } from './support/operator-fixtures.ts';

// S5-A browser validators (A4/A6): a response is accepted whole or rejected with a fixed code; nothing partial is kept.
const code = (fn: () => unknown): string => {
  try { fn(); return 'OK'; } catch (error) { assert.ok(error instanceof Invalid); return error.message; }
};

test('client list: exact shape, ID policy, no repeats, cap at 10 000, additive fields dropped', () => {
  const list = validateClients([{ id: 'a', name: 'A', extra: '<b>x</b>' }, { id: 'b', name: '' }]);
  assert.deepEqual(list, [{ id: 'a', name: 'A' }, { id: 'b', name: '' }]);
  assert.ok(Object.isFrozen(list[0]));
  assert.equal(code(() => validateClients([])), 'OK');
  for (const bad of [{}, null, 'x', [{ id: 'a' }], [{ id: 1, name: 'x' }], [{ id: '../x', name: 'x' }], [{ id: ' a', name: 'x' }],
    [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }], [null], [{ id: 'a', name: null }]]) {
    assert.equal(code(() => validateClients(bad)), 'RESPONSE_INVALID', JSON.stringify(bad));
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c-${i}`, name: `Client ${i}` }));
  assert.equal(validateClients(many(10_000)).length, 10_000);
  assert.equal(code(() => validateClients(many(10_001))), 'RESPONSE_TOO_LARGE');
});

test('picker: at most 250 rows in server order, explicit limitation, local search reaches later clients', () => {
  const clients = validateClients(Array.from({ length: 300 }, (_, i) => ({ id: `c-${String(i).padStart(3, '0')}`, name: `Client ${i}` })));
  const all = pickerView(clients, '');
  assert.equal(all.rows.length, 250); assert.equal(all.matching, 300); assert.equal(all.total, 300); assert.ok(all.limited);
  assert.equal(all.rows[0]!.id, 'c-000'); assert.equal(all.rows[249]!.id, 'c-249');
  const narrowed = pickerView(clients, 'C-299');
  assert.deepEqual(narrowed.rows.map(r => r.id), ['c-299']); assert.equal(narrowed.limited, false);
  assert.deepEqual(pickerView(clients, 'client 29').rows.map(r => r.id).slice(0, 3), ['c-029', 'c-290', 'c-291']);
  assert.deepEqual(pickerView(clients, 'zzz').rows, []);
});

test('display text is shortened by code points with a marker; IDs are never shortened', () => {
  const long = '😀'.repeat(4001);
  const shown = displayText(long);
  assert.equal(Array.from(shown.text).length, 4000); assert.equal(shown.shortened, true);
  assert.deepEqual(displayText('short'), { text: 'short', shortened: false });
  assert.deepEqual(clientLabel({ id: 'c-1', name: '   ' }), { text: 'c-1', shortened: false });
});

test('fixture and DB-shaped contexts validate into the explicit displayed projection only', async () => {
  const fixture = await fixtureContext();
  const view = validateContext(fixture, 'demo-gasta', null);
  assert.deepEqual({ ...view, people: undefined, devices: undefined, links: undefined, resources: undefined },
    { workspaceId: 'demo-vardahei', clientId: 'demo-gasta', clientName: 'Gasta (synthetic)', mode: 'fixture', completeness: 'COMPLETE_FIXTURE', generatedAt: fixture.generatedAt,
      people: undefined, devices: undefined, links: undefined, resources: undefined });
  assert.deepEqual(view.people, [{ id: 'demo-kari', displayName: 'Kari (synthetic)' }], 'Person.email is validated but never retained');
  assert.deepEqual(view.devices, [{ id: 'demo-device-07', hostname: 'GASTA-LT-07', personId: 'demo-kari' }]);
  assert.deepEqual(view.links.map(l => Object.keys(l).sort()), [0, 1].map(() => ['connectionId', 'entityId', 'entityKind', 'externalId', 'resourceType', 'system']),
    'links keep no workspace/client/status copy beyond the validated projection');
  const alert = view.resources[0]!.items![0]!;
  assert.deepEqual(Object.keys(alert).sort(), ['externalEventId', 'kind', 'occurredAt', 'revision', 'shape', 'sourceSeverity', 'summary']);
  assert.equal(JSON.stringify(view).includes('example.invalid'), false);
  for (const hidden of ['facts', 'externalDevice', 'receivedAt', 'safeErrorCode', 'email']) assert.equal(JSON.stringify(view).includes(`"${hidden}"`), false, hidden);
  const db = dbContext();
  assert.equal(validateContext(db, 'demo-gasta', 'demo-vardahei').mode, 'db');
  const additive = validateContext(mutate(db, c => { c.extra = { anything: true }; c.people[0].nickname = 'x'; c.resources[0].items[0].url = 'https://x.invalid'; }), 'demo-gasta', null);
  assert.equal(JSON.stringify(additive).includes('nickname') || JSON.stringify(additive).includes('x.invalid') || 'extra' in additive, false, 'additive fields ignored and dropped');
  // Financial (PowerOffice) content is validated as before but never retained for display.
  const finance = mutate(db, c => { c.resources.push({ ...c.resources[1], source: 'poweroffice', connectionId: 'conn-po' }); c.links.push({ ...c.links[0], system: 'poweroffice', connectionId: 'conn-po' }); });
  const shown = validateContext(finance, 'demo-gasta', null);
  assert.deepEqual([shown.resources.map(r => r.source), shown.links.map(l => l.system)], [['atera', 'atera', 'huntress'], ['atera']]);
});

test('context scope: requested client, established workspace and every nested row', async () => {
  const db = dbContext();
  assert.equal(code(() => validateContext(db, 'other-client', null)), 'RESPONSE_INVALID');
  assert.equal(code(() => validateContext(db, 'demo-gasta', 'other-workspace')), 'RESPONSE_INVALID');
  const cases: [string, (c: any) => void][] = [
    ['person client', c => { c.people[0].clientId = 'x'; }], ['device workspace', c => { c.devices[0].workspaceId = 'x'; }],
    ['link client', c => { c.links[0].clientId = 'x'; }], ['observation client', c => { c.observations.items[0].clientId = 'x'; }],
    ['candidate link', c => { c.links[0].status = 'CANDIDATE'; }], ['quarantined link', c => { c.links[0].status = 'QUARANTINED'; }],
    ['m365 link', c => { c.links[0].system = 'microsoft365'; }], ['m365 resource type', c => { c.links[0].resourceType = 'm365_user'; }],
    ['unknown severity', c => { c.observations.items[0].severity = 'SEVERE'; }], ['resolved in context', c => { c.observations.items[0].status = 'RESOLVED'; }],
    ['unknown route', c => { c.observations.items[0].route = 'AUTO'; }], ['confidence > 1', c => { c.observations.items[0].confidence = 2; }],
    ['bad time', c => { c.observations.items[0].occurredAt = 'yesterday'; }], ['total < items', c => { c.observations.total = 0; }],
    ['missing count', c => { delete c.observations.counts.LOW; }], ['bad cursor', c => { c.observations.nextCursor = 'a b'; }],
    ['resource status', c => { c.resources[0].status = 'GREEN'; }], ['FIXTURE in db mode', c => { c.resources[0].status = 'FIXTURE'; }],
    ['MISSING with items', c => { c.resources[1].items = []; }], ['OK without items', c => { c.resources[0].items = null; }],
    ['snapshot item source', c => { c.resources[0].items[0].source = 'huntress'; }], ['snapshot severity', c => { c.resources[0].items[0].severity = 'x'; }],
    ['snapshot status not text', c => { c.resources[0].items[0].status = 5; }], ['unknown item shape', c => { c.resources[0].items[0] = { anything: 1 }; }],
    ['completeness mismatch', c => { c.completeness = 'COMPLETE_FIXTURE'; }], ['contract version', c => { c.contractVersion = 'ClientContextV2'; }],
    ['mode', c => { c.mode = 'live'; }], ['generatedAt', c => { c.generatedAt = null; }], ['people not array', c => { c.people = {}; }]
  ];
  for (const [name, change] of cases) assert.equal(code(() => validateContext(mutate(db, change), 'demo-gasta', null)), 'RESPONSE_INVALID', name);
  assert.equal(code(() => validateContext(mutate(db, c => { c.resources[0].items[0].status = 'Any vendor text ✓'; }), 'demo-gasta', null)), 'OK',
    'snapshot status is bounded free text, not an Atlas enum');
  const fixture = await fixtureContext();
  for (const [name, change] of [
    ['fixture event scope', (c: any) => { c.resources[0].items[0].clientId = 'x'; }],
    ['fixture event connection', (c: any) => { c.resources[0].items[0].connectionId = 'other'; }],
    ['fixture ticket shape', (c: any) => { delete c.resources[1].items[0].title; }],
    ['OK in fixture mode', (c: any) => { c.resources[0].status = 'OK'; }]
  ] as [string, (c: any) => void][]) assert.equal(code(() => validateContext(mutate(fixture, change), 'demo-gasta', null)), 'RESPONSE_INVALID', name);
});

test('context caps: oversized arrays are RESPONSE_TOO_LARGE, never partial', () => {
  const db = dbContext();
  const grow = (n: number, row: unknown) => Array.from({ length: n }, () => structuredClone(row));
  assert.equal(code(() => validateContext(mutate(db, c => { c.people = grow(1000, c.people[0]); }), 'demo-gasta', null)), 'OK');
  for (const [name, change] of [
    ['people', (c: any) => { c.people = grow(1001, c.people[0]); }], ['devices', (c: any) => { c.devices = grow(1001, c.devices[0]); }],
    ['links', (c: any) => { c.links = grow(1001, c.links[0]); }], ['queue', (c: any) => { c.observations.items = grow(101, c.observations.items[0]); c.observations.total = 101; }],
    ['resources', (c: any) => { c.resources = grow(101, c.resources[1]); }], ['resource items', (c: any) => { c.resources[0].items = grow(1001, c.resources[0].items[0]); }]
  ] as [string, (c: any) => void][]) assert.equal(code(() => validateContext(mutate(db, change), 'demo-gasta', null)), 'RESPONSE_TOO_LARGE', name);
});

test('R2: a fixture context page is a fixed demo page — truncation or a cursor is RESPONSE_INVALID; DB paging unchanged', async () => {
  const fixture = await fixtureContext();
  assert.equal(code(() => validateContext(fixture, 'demo-gasta', null)), 'OK', 'accepted fixture overview unchanged');
  assert.equal(code(() => validateContext(mutate(fixture, c => { c.observations.truncated = false; c.observations.nextCursor = null; }), 'demo-gasta', null)), 'OK');
  for (const [name, change] of [
    ['cursor and truncated', (c: any) => { c.observations.truncated = true; c.observations.nextCursor = 'cursor'; }],
    ['cursor only', (c: any) => { c.observations.nextCursor = 'cursor'; }],
    ['truncated only', (c: any) => { c.observations.truncated = true; }]
  ] as [string, (c: any) => void][]) assert.equal(code(() => validateContext(mutate(fixture, change), 'demo-gasta', null)), 'RESPONSE_INVALID', name);
  const db = dbContext();
  for (const [name, change] of [
    ['truncated with cursor', (c: any) => { c.observations.truncated = true; c.observations.nextCursor = 'cursor'; c.observations.total = 150; }],
    ['cursor without truncation flag', (c: any) => { c.observations.nextCursor = 'cursor'; }],
    ['truncated without cursor', (c: any) => { c.observations.truncated = true; }]
  ] as [string, (c: any) => void][]) assert.equal(code(() => validateContext(mutate(db, change), 'demo-gasta', null)), 'OK', `db ${name}`);
  assert.equal(code(() => validateContext(mutate(db, c => { c.observations.nextCursor = 'not a cursor'; }), 'demo-gasta', null)), 'RESPONSE_INVALID');
});
