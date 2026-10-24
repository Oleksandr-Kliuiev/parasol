import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ObservationPage, ObservationSummary } from '../packages/core/contracts.ts';
import { startApi } from './support/api-process.ts';
import type { ApiProcess } from './support/api-process.ts';

// The actual compiled fixture HTTP route. It reads the fixed synthetic context, never a provider or database.
const token = 'synthetic-observation-detail-fixture-token';
let api: ApiProcess;
before(async () => { api = await startApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token, ATLAS_ASK_MODE: 'off' }); });
after(async () => { await api?.stop(); });
const call = (path: string, authenticated = true) => fetch(`${api.base}${path}`, {
  headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
});

test('fixture exact read equals its stored page item and is no-store; query values do not change the selected ID', async () => {
  const page = await (await call('/clients/demo-gasta/observations')).json() as ObservationPage;
  assert.ok(page.items.length > 0);
  for (const expected of page.items) {
    const response = await call(`/clients/demo-gasta/observations/${encodeURIComponent(expected.id)}?status=RESOLVED&clientId=other`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json() as ObservationSummary, expected);
  }
});

test('fixture exact read refuses absent credentials/scope and safely distinguishes malformed and missing IDs', async () => {
  assert.equal((await call('/clients/demo-gasta/observations/missing', false)).status, 401);
  for (const client of ['demo-other', 'no-such-client'])
    assert.equal((await call(`/clients/${client}/observations/missing`)).status, 403);
  for (const id of ['bad%00id', 'bad%0Aid', 'bad%2Fid', 'x'.repeat(101)])
    assert.equal((await call(`/clients/demo-gasta/observations/${id}`)).status, 400);
  const missing = await call('/clients/demo-gasta/observations/missing');
  assert.equal(missing.status, 404);
  assert.ok(!(await missing.text()).includes('missing'), 'safe error has no source or requested record contents');
});
