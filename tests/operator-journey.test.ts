import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { createController } from '../apps/operator/src/controller.ts';
import { dbContext } from './support/operator-fixtures.ts';
import { journeyItems, observation, page, resourceView, snapshotAlert, WS } from './support/operator-journey.ts';

// S5-B controller (B1, B3, B6): context → queue → selection → evidence with deferred responses whose fake fetch IGNORES
// AbortSignal. Every stale success, error, 401 and 403 must change nothing; isolation comes from the captured
// credential/scope/panel generations and, for evidence, the selected observation and its exact source tuple.
const A = 'synthetic-console-token-aaaaaaaaaaaa';
const B = 'synthetic-console-token-bbbbbbbbbbbb';
interface Pending { method: string; path: string; body: string | null; resolve(response: Response): void }

function harness() {
  const pending: Pending[] = [];
  // ASK-B compatibility: the Ask capability GET is answered 404 (Ask OFF, the accepted console behaviour) and not recorded.
  const holder = createCredentialHolder((path, init) => path === '/ask/capabilities' ? Promise.resolve(new Response('', { status: 404 }))
    : new Promise<Response>(resolve => {
      pending.push({ method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : null, resolve });
    }));
  let ids = 0;
  const controller = createController(holder, () => undefined, { deadlineMs: 2000, requestId: () => `req-${String(++ids).padStart(4, '0')}-synthetic` });
  /** The newest still-unanswered request for a path prefix (query ignored). */
  const take = (prefix: string): Pending => {
    const index = pending.findLastIndex(p => p.path.split('?')[0] === prefix || p.path.startsWith(prefix));
    assert.ok(index >= 0, `request ${prefix}`);
    return pending.splice(index, 1)[0]!;
  };
  return { holder, controller, pending, take, all: [] as Pending[] };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const CLIENTS = [{ id: 'c-db', name: 'DB (synthetic)' }, { id: 'c-two', name: 'Two (synthetic)' }];
const alertView = (ids: string[]) => resourceView('OK', ids.map(id => snapshotAlert(id)));

/** Connected, c-db selected, its context and first queue page answered. */
async function ready(h = harness(), items = journeyItems()) {
  h.controller.connect(A);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  h.controller.select('c-db');
  h.take('/clients/c-db/overview').resolve(json(dbContext('c-db', WS))); await settle();
  h.take('/clients/c-db/observations').resolve(json(page(items, { total: 40, truncated: true, nextCursor: 'cursor_2' }))); await settle();
  assert.equal(h.controller.state().queue.status, 'READY');
  return h;
}

test('queue starts only after a validated context, once, with the explicit default DB selection', async () => {
  const h = harness();
  h.controller.connect(A);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  h.controller.select('c-db');
  assert.deepEqual(h.pending.map(p => p.path), ['/clients/c-db/overview'], 'no queue request before the context validates');
  h.take('/clients/c-db/overview').resolve(json(dbContext('c-db', 'other-ws-but-first'))); await settle();
  assert.deepEqual(h.pending.map(p => p.path), ['/clients/c-db/observations?status=OPEN%2CACKNOWLEDGED&severity=INFO%2CLOW%2CMEDIUM%2CHIGH%2CCRITICAL&limit=25']);
  h.controller.refreshContext();
  h.take('/clients/c-db/overview').resolve(json({ ...dbContext('c-db', 'other-ws-but-first'), contractVersion: 'X' })); await settle();
  assert.equal(h.controller.state().context.error, 'RESPONSE_INVALID');
  assert.equal(h.pending.filter(p => p.path.includes('/observations')).length, 1, 'an invalid context never starts a queue (the earlier one is stale)');
  h.take('/clients/c-db/observations').resolve(json(page([observation('o-1', {}, 'c-db')]))); await settle();
  assert.equal(h.controller.state().queue.status, 'IDLE', 'the queue of the replaced context is ignored');
});

test('filter, page and refresh clear page, selection and evidence synchronously; next page replaces, first/refresh reset', async () => {
  const h = await ready();
  h.controller.selectObservation('obs-alert');
  h.controller.requestEvidence();
  assert.equal(h.controller.state().evidence.status, 'LOADING');
  assert.equal(h.controller.applyQueue([], ['HIGH'], 25), false, 'empty status selection refused');
  assert.equal(h.pending.filter(p => p.path.includes('/observations')).length, 0, 'nothing sent for a refused selection');
  assert.equal(h.controller.applyQueue(['RESOLVED', 'OPEN'], ['HIGH', 'CRITICAL'], 50), true);
  let s = h.controller.state();
  assert.deepEqual([s.queue.status, s.observationId, s.evidence.status, s.queuePosition.number], ['LOADING', null, 'IDLE', 1]);
  const filtered = h.take('/clients/c-db/observations');
  assert.match(filtered.path, /status=OPEN%2CRESOLVED&severity=HIGH%2CCRITICAL&limit=50$/);
  h.take('/tools/execute').resolve(json(alertView(['alert-1']), 201)); await settle();
  assert.equal(h.controller.state().evidence.status, 'IDLE', 'evidence of the previous page is stale');
  filtered.resolve(json(page([observation('h-1', { severity: 'HIGH' })], { total: 3, truncated: true, nextCursor: 'cursor_B' }))); await settle();
  h.controller.nextPage();
  const second = h.take('/clients/c-db/observations');
  assert.match(second.path, /&cursor=cursor_B$/);
  assert.equal(h.controller.state().queue.data, null, 'the current page is cleared before the next one arrives');
  second.resolve(json(page([observation('h-2', { severity: 'CRITICAL', status: 'RESOLVED' })], { total: 3 }))); await settle();
  s = h.controller.state();
  assert.deepEqual([s.queue.data?.items.map(i => i.id), s.queuePosition.number], [['h-2'], 2], 'one page retained, replaced');
  h.controller.firstPage();
  assert.doesNotMatch(h.take('/clients/c-db/observations').path, /cursor=/);
  h.controller.refreshQueue();
  assert.equal(h.controller.state().queuePosition.number, 1);
  assert.doesNotMatch(h.take('/clients/c-db/observations').path, /cursor=/, 'refresh resets to the first page');
});

test('fixture queue: no query; filter and paging input is refused locally as RESPONSE_INVALID with no request', async () => {
  const h = harness();
  h.controller.connect(A);
  h.take('/clients').resolve(json([{ id: 'demo-gasta', name: 'Gasta' }])); await settle();
  h.controller.select('demo-gasta');
  const { fixtureContext } = await import('./support/operator-fixtures.ts');
  const fixture = await fixtureContext();
  h.take('/clients/demo-gasta/overview').resolve(json(fixture)); await settle();
  const queue = h.take('/clients/demo-gasta/observations');
  assert.equal(queue.path, '/clients/demo-gasta/observations');
  queue.resolve(json(fixture.observations)); await settle();
  for (const action of [() => h.controller.applyQueue(['OPEN'], ['HIGH'], 25), () => h.controller.nextPage(), () => h.controller.firstPage()]) {
    action();
    assert.equal(h.controller.state().queue.error, 'RESPONSE_INVALID');
    assert.equal(h.pending.length, 0, 'never sent');
    h.controller.retryQueue();
    h.take('/clients/demo-gasta/observations').resolve(json(fixture.observations)); await settle();
  }
});

test('stale queue completions (success, error, 401, 403) after client, filter or credential switches change nothing', async () => {
  for (const response of [() => status(403), () => status(401), () => status(500), () => json(page([observation('x')]))]) {
    const h = await ready();
    h.controller.refreshQueue();
    const old = h.take('/clients/c-db/observations');
    h.controller.select('c-two');
    h.take('/clients/c-two/overview').resolve(json(dbContext('c-two', WS))); await settle();
    old.resolve(response()); await settle();
    const s = h.controller.state();
    assert.deepEqual([s.session, s.selection?.clientId, s.queue.status, s.scopeDenied], ['READY', 'c-two', 'LOADING', false], 'client switch');
    assert.equal(h.pending.filter(p => p.path === '/clients').length, 0, 'a stale 403 never refreshes the picker');
    const current = h.take('/clients/c-two/observations');
    h.controller.applyQueue(['OPEN'], ['LOW'], 25);
    current.resolve(response()); await settle();
    assert.deepEqual([h.controller.state().session, h.controller.state().selection?.clientId, h.controller.state().queue.status], ['READY', 'c-two', 'LOADING'], 'filter switch');
    const filtered = h.take('/clients/c-two/observations');
    h.controller.connect(B);
    filtered.resolve(response()); await settle();
    const after = h.controller.state();
    assert.deepEqual([after.session, after.selection, after.queue.status, after.clients.status], ['CONNECTING', null, 'IDLE', 'LOADING'], 'credential switch');
  }
});

test('current queue 403: full scope reset and exactly one picker refresh, no auto-select; a refused picker does not recurse', async () => {
  const h = await ready();
  h.controller.refreshQueue();
  h.take('/clients/c-db/observations').resolve(status(403)); await settle();
  const s = h.controller.state();
  assert.deepEqual([s.selection, s.context.status, s.queue.status, s.observationId, s.evidence.status, s.scopeDenied], [null, 'IDLE', 'IDLE', null, 'IDLE', true]);
  assert.deepEqual(h.pending.map(p => p.path), ['/clients']);
  h.take('/clients').resolve(status(403)); await settle();
  assert.equal(h.pending.length, 0); assert.equal(h.controller.state().selection, null);
});

test('evidence: only a deliberate request sends, exact body, fresh request ID; a pending click sends nothing more', async () => {
  const h = await ready();
  h.controller.selectObservation('obs-alert');
  assert.equal(h.pending.length, 0, 'selection never reads evidence');
  h.controller.requestEvidence(); h.controller.requestEvidence();
  const first = h.take('/tools/execute');
  assert.equal(h.pending.length, 0, 'one pending read per selection');
  assert.deepEqual([first.method, first.body], ['POST', '{"version":"1","clientId":"c-db","tool":"atera.alert.list","parameters":{"connectionId":"conn-atera"},"requestId":"req-0001-synthetic"}']);
  first.resolve(status(500)); await settle();
  assert.equal(h.controller.state().evidence.error, 'HTTP_ERROR');
  h.controller.requestEvidence();
  const retry = h.take('/tools/execute');
  assert.match(retry.body!, /"requestId":"req-0002-synthetic"/, 'explicit retry has a fresh request ID');
  retry.resolve(json(alertView(['alert-0', 'alert-1']), 201)); await settle();
  assert.deepEqual(h.controller.state().evidence.data?.items?.map(i => i.shape === 'snapshot' && i.externalId), ['alert-1']);
  h.controller.selectObservation('obs-ticket');
  assert.equal(h.controller.state().evidence.status, 'IDLE', 'selection clears evidence synchronously');
  h.controller.requestEvidence();
  assert.match(h.take('/tools/execute').body!, /"tool":"atera.ticket.get","parameters":\{"connectionId":"conn-atera","ticketId":"ticket-7"\}/);
});

test('stale evidence after a selection, page, client or credential change: success, error, 401 and 403 change nothing', async () => {
  for (const change of ['selection', 'page', 'client', 'credential'] as const) {
    for (const response of [() => json(alertView(['alert-1']), 201), () => status(500), () => status(401), () => status(403)]) {
      const h = await ready();
      h.controller.selectObservation('obs-alert');
      h.controller.requestEvidence();
      const old = h.take('/tools/execute');
      if (change === 'selection') h.controller.selectObservation('obs-ticket');
      if (change === 'page') h.controller.refreshQueue();
      if (change === 'client') h.controller.select('c-two');
      if (change === 'credential') h.controller.connect(B);
      const before = h.controller.state();
      const sent = h.pending.length;
      old.resolve(response()); await settle();
      const after = h.controller.state();
      assert.equal(after, before, `${change}: stale evidence changed state`);
      assert.equal(h.pending.length, sent, `${change}: stale evidence sent a request`);
    }
  }
});

test('current evidence 403 resets the whole scope with one picker refresh; current 401 disconnects; huntress fixture/unsupported never send', async () => {
  const h = await ready();
  h.controller.selectObservation('obs-crit');
  h.controller.requestEvidence();
  assert.match(h.take('/tools/execute').body!, /"tool":"huntress.incident.get".*"incidentId":"inc-1"/);
  const denied = await ready();
  denied.controller.selectObservation('obs-alert');
  denied.controller.requestEvidence();
  denied.take('/tools/execute').resolve(status(403)); await settle();
  assert.deepEqual([denied.controller.state().selection, denied.controller.state().scopeDenied, denied.pending.map(p => p.path)], [null, true, ['/clients']]);
  const gone = await ready();
  gone.controller.selectObservation('obs-alert');
  gone.controller.requestEvidence();
  gone.take('/tools/execute').resolve(status(401)); await settle();
  assert.deepEqual([gone.controller.state().session, gone.holder.connected()], ['DISCONNECTED', false]);
  const odd = await ready(harness(), [observation('o-agent', { resourceType: 'agent' }), observation('o-bad', { externalEventId: 'has space' })]);
  for (const id of ['o-agent', 'o-bad']) { odd.controller.selectObservation(id); odd.controller.requestEvidence(); }
  assert.equal(odd.pending.length, 0);
  assert.equal(odd.controller.state().evidence.status, 'IDLE');
});

test('an aborted older read never overwrites the newer one, even when the same observation/page is selected again at once', async () => {
  // The abort of the older request settles it locally (NETWORK) in a later microtask; by then the same observation or the
  // same page may be current again with a newer pending request. Only the generation tells them apart.
  const h = await ready();
  h.controller.selectObservation('obs-alert');
  h.controller.requestEvidence();
  const older = h.take('/tools/execute');
  h.controller.selectObservation('obs-ticket'); h.controller.selectObservation('obs-alert'); h.controller.requestEvidence();
  await settle();
  assert.equal(h.controller.state().evidence.status, 'LOADING', 'the older aborted evidence read is stale, not an error of the newer one');
  older.resolve(json(alertView(['alert-1']), 201)); await settle();
  assert.equal(h.controller.state().evidence.status, 'LOADING');
  h.take('/tools/execute').resolve(json(alertView(['alert-1']), 201)); await settle();
  assert.equal(h.controller.state().evidence.status, 'READY');
  h.controller.refreshQueue(); h.controller.refreshQueue();
  await settle();
  assert.equal(h.controller.state().queue.status, 'LOADING', 'the older aborted page load is stale, not an error of the newer one');
});
