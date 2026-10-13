import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { createController } from '../apps/operator/src/controller.ts';
import type { ConsoleState } from '../apps/operator/src/state.ts';
import { dbContext } from './support/operator-fixtures.ts';

// S5-A state machine (A4/A5/A7) with deferred responses whose fake fetch IGNORES AbortSignal: isolation must come from
// the captured credential/scope/panel generations, not from abort. The browser suite repeats the key races over the DOM.
// Since S5-B a validated context is followed by one queue request, so requests are found by path, not by position.
const A = 'synthetic-console-token-aaaaaaaaaaaa';
const B = 'synthetic-console-token-bbbbbbbbbbbb';

interface Pending { path: string; auth: string; resolve(response: Response): void }
function harness() {
  const pending: Pending[] = [];
  // ASK-B compatibility: the Ask capability GET that follows a validated client list is answered 404 (Ask OFF, the accepted
  // console behaviour) and not recorded, so these S5-A cases keep their exact request indices. Ask: operator-ask-*.test.ts.
  const holder = createCredentialHolder((path, init) => path === '/ask/capabilities' ? Promise.resolve(new Response('', { status: 404 }))
    : new Promise<Response>(resolve => {
      pending.push({ path, auth: new Headers(init.headers).get('authorization') ?? '', resolve });
    }));
  const states: ConsoleState[] = [];
  const controller = createController(holder, state => states.push(state), { deadlineMs: 500 });
  return { holder, controller, pending, states };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const clients = [{ id: 'demo-gasta', name: 'Gasta (synthetic)' }, { id: 'demo-other', name: 'Other (synthetic)' }];
const paths = (pending: Pending[]) => pending.map(p => p.path.split('?')[0]);

test('malformed token: no request, disconnected with a fixed notice', () => {
  const { controller, pending } = harness();
  controller.connect(`${A} `);
  assert.equal(pending.length, 0);
  assert.equal(controller.state().session, 'DISCONNECTED'); assert.equal(controller.state().notice, 'TOKEN_FORMAT');
});

test('token replacement: stale success, 401 and error of the old epoch change nothing', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  controller.connect(B);
  await settle();
  assert.equal(controller.state().clients.status, 'LOADING', 'the aborted old request settles as stale, not as an error of the new session');
  assert.equal(pending.length, 2);
  assert.ok(pending[0]!.auth.endsWith(A) && pending[1]!.auth.endsWith(B));
  pending[1]!.resolve(json([clients[1]])); await settle();
  assert.deepEqual(controller.state().clients.data, [clients[1]]);
  pending[0]!.resolve(json(clients)); await settle();
  assert.deepEqual(controller.state().clients.data, [clients[1]], 'old success ignored');
  controller.refreshClients(); controller.refreshClients();
  pending[2]!.resolve(status(401)); await settle();
  assert.equal(controller.state().session, 'READY', 'stale 401 of an older panel generation ignored');
  pending[3]!.resolve(status(500)); await settle();
  assert.equal(controller.state().clients.error, 'HTTP_ERROR');
});

test('no client is ever selected automatically; selection requires a validated picker entry', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  pending[0]!.resolve(json(clients)); await settle();
  assert.equal(controller.state().selection, null);
  controller.select('not-listed');
  assert.equal(pending.length, 1); assert.equal(controller.state().selection, null);
  controller.select('demo-gasta');
  assert.equal(pending[1]!.path, '/clients/demo-gasta/overview');
});

test('client switch: the old context completion (success, 403) cannot touch the new scope', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  pending[0]!.resolve(json(clients)); await settle();
  controller.select('demo-gasta');
  controller.select('demo-other');
  await settle();
  assert.equal(controller.state().context.status, 'LOADING', 'the aborted old context settles as stale, not as an error of the new scope');
  pending[2]!.resolve(json(dbContext('demo-other'))); await settle();
  assert.equal(controller.state().context.data?.clientId, 'demo-other');
  pending[1]!.resolve(status(403)); await settle();
  assert.equal(controller.state().selection?.clientId, 'demo-other', 'stale 403 ignored');
  assert.deepEqual(paths(pending), ['/clients', '/clients/demo-gasta/overview', '/clients/demo-other/overview', '/clients/demo-other/observations'],
    'stale 403 does not refresh the picker; only the current context\'s queue follows');
  assert.equal(controller.state().context.status, 'READY');
});

test('first context fixes the workspace for this credential; another workspace is RESPONSE_INVALID with no data', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  pending[0]!.resolve(json(clients)); await settle();
  controller.select('demo-gasta');
  pending[1]!.resolve(json(dbContext('demo-gasta', 'ws-1'))); await settle();
  controller.select('demo-other');
  pending.at(-1)!.resolve(json(dbContext('demo-other', 'ws-2'))); await settle();
  assert.equal(controller.state().context.error, 'RESPONSE_INVALID'); assert.equal(controller.state().context.data, null);
  controller.select('demo-gasta');
  pending.at(-1)!.resolve(json(dbContext('demo-gasta', 'other-ws'))); await settle();
  assert.equal(controller.state().context.error, 'RESPONSE_INVALID');
  assert.equal(paths(pending).filter(p => p.endsWith('/observations')).length, 1, 'a context of another workspace never starts a queue');
});

test('current 403: full scope reset plus exactly one picker refresh, no auto-select and no loop', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  pending[0]!.resolve(json(clients)); await settle();
  controller.select('demo-gasta');
  pending[1]!.resolve(status(403)); await settle();
  const state = controller.state();
  assert.equal(state.selection, null); assert.equal(state.context.status, 'IDLE'); assert.equal(state.scopeDenied, true);
  assert.equal(pending.length, 3); assert.equal(pending[2]!.path, '/clients');
  pending[2]!.resolve(status(403)); await settle();
  assert.equal(controller.state().clients.error, 'FORBIDDEN');
  assert.equal(pending.length, 3, 'a refused refresh is not retried');
});

test('current 401 disconnects globally and clears everything; later completions are ignored', async () => {
  const { controller, pending, holder } = harness();
  controller.connect(A);
  pending[0]!.resolve(json(clients)); await settle();
  controller.select('demo-gasta');
  controller.refreshClients();
  pending[1]!.resolve(status(401)); await settle();
  assert.equal(controller.state().session, 'DISCONNECTED'); assert.equal(controller.state().notice, 'UNAUTHORIZED');
  assert.equal(holder.connected(), false);
  pending[2]!.resolve(json(clients)); await settle();
  assert.equal(controller.state().clients.data, null, 'late success after 401 ignored');
});

test('disconnect during a deferred request: nothing is restored by its completion', async () => {
  const { controller, pending } = harness();
  controller.connect(A);
  controller.disconnect('DISCONNECTED');
  pending[0]!.resolve(json(clients)); await settle();
  assert.equal(controller.state().session, 'DISCONNECTED'); assert.equal(controller.state().clients.data, null);
});
