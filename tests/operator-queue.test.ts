import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationPath } from '../apps/operator/src/operations.ts';
import { DEFAULT_QUEUE_QUERY, queueQuery } from '../apps/operator/src/queue-query.ts';
import { validatePage } from '../apps/operator/src/validate-observations.ts';
import type { PageSelection } from '../apps/operator/src/validate-observations.ts';
import { Invalid } from '../apps/operator/src/validate-core.ts';
import { parseObservationQuery } from '../apps/api/src/http-boundary.ts';
import { observation, page } from './support/operator-journey.ts';
import { mutate } from './support/operator-fixtures.ts';

// S5-B queue (B1, B2, B5): the selection is closed over known values, the request is built from it alone, and a page is
// accepted whole only when every item satisfies the captured scope and selection. Server order is never changed.
const scope = { workspaceId: 'demo-vardahei', clientId: 'c-db' };
const db = (query = DEFAULT_QUEUE_QUERY): PageSelection => ({ mode: 'db', query });
const fixture: PageSelection = { mode: 'fixture' };
const code = (fn: () => unknown): string => {
  try { fn(); return 'OK'; } catch (error) { assert.ok(error instanceof Invalid); return error.message; }
};

test('queue selection: canonical non-empty known subsets and offered page sizes only; anything else is refused locally', () => {
  assert.deepEqual(queueQuery(['ACKNOWLEDGED', 'OPEN'], ['CRITICAL', 'INFO'], 50), { statuses: ['OPEN', 'ACKNOWLEDGED'], severities: ['INFO', 'CRITICAL'], limit: 50 });
  assert.deepEqual(DEFAULT_QUEUE_QUERY, { statuses: ['OPEN', 'ACKNOWLEDGED'], severities: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], limit: 25 });
  for (const [statuses, severities, limit] of [[[], ['LOW'], 25], [['OPEN'], [], 25], [['OPEN', 'OPEN'], ['LOW'], 25], [['open'], ['LOW'], 25],
    [['OPEN'], ['SEVERE'], 25], [['OPEN'], ['LOW'], 10], [['OPEN'], ['LOW'], '25'], [['OPEN'], ['LOW'], 101], [['OPEN', 'X', 'Y', 'Z', 'W'], ['LOW'], 25]] as const) {
    assert.equal(queueQuery(statuses, severities, limit), null, JSON.stringify([statuses, severities, limit]));
  }
});

test('queue request: fixture has no query at all; DB sends the explicit selection, the server accepts it, malformed input sends nothing', () => {
  assert.equal(operationPath({ kind: 'observations', clientId: 'demo-gasta', page: null }), '/clients/demo-gasta/observations');
  const path = operationPath({ kind: 'observations', clientId: 'a:b', page: { query: DEFAULT_QUEUE_QUERY, cursor: null } })!;
  assert.equal(path, '/clients/a%3Ab/observations?status=OPEN%2CACKNOWLEDGED&severity=INFO%2CLOW%2CMEDIUM%2CHIGH%2CCRITICAL&limit=25');
  const next = operationPath({ kind: 'observations', clientId: 'c', page: { query: queueQuery(['RESOLVED'], ['HIGH'], 100)!, cursor: 'abc_DEF-1' } })!;
  const params = Object.fromEntries(new URL(next, 'http://x').searchParams);
  assert.deepEqual(params, { status: 'RESOLVED', severity: 'HIGH', limit: '100', cursor: 'abc_DEF-1' });
  // The accepted server parser takes exactly what the console sends (no 400 for a well-formed console request).
  assert.deepEqual(parseObservationQuery(params, 100), { statuses: ['RESOLVED'], severities: ['HIGH'], limit: 100, cursor: 'abc_DEF-1' });
  for (const bad of [{ clientId: '../x', page: null }, { clientId: 'c', page: { query: DEFAULT_QUEUE_QUERY, cursor: 'a b' } },
    { clientId: 'c', page: { query: DEFAULT_QUEUE_QUERY, cursor: 'x'.repeat(401) } },
    { clientId: 'c', page: { query: { ...DEFAULT_QUEUE_QUERY, statuses: ['OPEN', 'BOGUS'] }, cursor: null } },
    { clientId: 'c', page: { query: { ...DEFAULT_QUEUE_QUERY, limit: 7 }, cursor: null } }]) {
    assert.equal(operationPath({ kind: 'observations', ...bad } as never), null, JSON.stringify(bad).slice(0, 80));
  }
});

test('DB page: whole-page validation against the captured selection, limit, scope and unique IDs; server order kept', () => {
  const items = [observation('o-3', { severity: 'LOW' }), observation('o-1', { severity: 'CRITICAL' }), observation('o-2', { status: 'ACKNOWLEDGED' })];
  const valid = validatePage(page(items, { total: 30, truncated: true, nextCursor: 'next_1' }), scope, db());
  assert.deepEqual(valid.items.map(i => i.id), ['o-3', 'o-1', 'o-2'], 'no local re-sorting');
  assert.deepEqual([valid.total, valid.truncated, valid.nextCursor, valid.mode], [30, true, 'next_1', 'db']);
  assert.deepEqual(Object.keys(valid.items[0]!).sort(), ['acknowledgedAt', 'confidence', 'conflictOfEventKey', 'connectionId', 'createdAt', 'decisionRunId', 'domain',
    'entityId', 'eventKey', 'externalEventId', 'id', 'kind', 'occurredAt', 'priority', 'provider', 'reasonCodes', 'resolvedAt', 'resourceType', 'revision', 'route',
    'severity', 'source', 'status', 'summary', 'supersededById', 'updatedAt'], 'explicit projection: no scope copy, no additive field');
  assert.equal(code(() => validatePage(page([observation('o', { extra: '<b>x</b>' })]), scope, db())), 'OK', 'additive item field ignored');
  const lowOnly = queueQuery(['OPEN'], ['LOW'], 25)!;
  const cases: [string, unknown, PageSelection][] = [
    ['status outside selection', page([observation('a', { status: 'RESOLVED' })]), db()],
    ['severity outside selection', page([observation('a', { severity: 'HIGH' })]), db(lowOnly)],
    ['more than requested limit', page(Array.from({ length: 26 }, (_, i) => observation(`o${i}`))), db()],
    ['duplicate IDs', page([observation('a'), observation('a', { severity: 'LOW' })]), db()],
    ['other client', page([observation('a', {}, 'c-other')]), db()],
    ['other workspace', page([{ ...observation('a'), workspaceId: 'ws-x' }]), db()],
    ['unknown source', page([observation('a', { source: 'vendor' })]), db()], ['unknown resource type', page([observation('a', { resourceType: 'm365_user' })]), db()],
    ['unknown kind', page([observation('a', { kind: 'X' })]), db()], ['unknown route', page([observation('a', { route: 'AUTO' })]), db()],
    ['unknown provider', page([observation('a', { provider: 'llm' })]), db()], ['unknown priority', page([observation('a', { priority: 'HIGH' })]), db()],
    ['unknown status', page([observation('a', { status: 'CLOSED' })]), db()], ['confidence NaN', page([observation('a', { confidence: Number.NaN })]), db()],
    ['confidence negative', page([observation('a', { confidence: -0.1 })]), db()], ['reason code not text', page([observation('a', { reasonCodes: [1] })]), db()],
    ['empty id', page([observation('a', { id: '' })]), db()], ['bad time', page([observation('a', { updatedAt: '10/10/2026' })]), db()],
    ['entity id empty', page([observation('a', { entityId: '' })]), db()], ['total below items', page([observation('a')], { total: 0 }), db()],
    ['bad cursor', page([], { nextCursor: 'a/b' }), db()], ['truncated not boolean', page([], { truncated: 'no' }), db()],
    ['missing count', mutate(page([]), p => { delete p.counts.HIGH; }), db()], ['negative count', mutate(page([]), p => { p.counts.LOW = -1; }), db()],
    ['items not array', { ...page([]), items: {} }, db()]
  ];
  for (const [name, value, selection] of cases) assert.equal(code(() => validatePage(value, scope, selection)), 'RESPONSE_INVALID', name);
  assert.equal(code(() => validatePage(page(Array.from({ length: 101 }, (_, i) => observation(`o${i}`))), scope, { mode: 'db', query: queueQuery(['OPEN'], ['MEDIUM'], 100)! })), 'RESPONSE_TOO_LARGE');
  assert.equal(code(() => validatePage(page([observation('a', { reasonCodes: Array(101).fill('R') })]), scope, db())), 'RESPONSE_TOO_LARGE');
});

test('fixture page: fixed active demo page, never a cursor or truncation, at most 100; inactive status refused', () => {
  assert.equal(code(() => validatePage(page([observation('a'), observation('b', { status: 'ACKNOWLEDGED' })]), scope, fixture)), 'OK');
  for (const [name, value] of [['cursor', page([], { nextCursor: 'c' })], ['truncated', page([], { truncated: true })], ['resolved', page([observation('a', { status: 'RESOLVED' })])],
    ['suppressed', page([observation('a', { status: 'SUPPRESSED' })])]] as [string, unknown][]) {
    assert.equal(code(() => validatePage(value, scope, fixture)), 'RESPONSE_INVALID', name);
  }
  assert.equal(code(() => validatePage(page(Array.from({ length: 101 }, (_, i) => observation(`o${i}`)), { total: 101 }), scope, fixture)), 'RESPONSE_TOO_LARGE');
});
