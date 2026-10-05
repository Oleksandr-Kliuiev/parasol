import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './provider.mjs';

async function withServer(options, action) {
  const server = createProvider(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('simulator preserves references, surfaces duplicate writes and exposes its assumptions', async () => {
  await withServer({ latencyMs: 0, jitterMs: 0, requestsPerSecond: 100 }, async (base) => {
    const request = { method: 'POST', body: JSON.stringify({ CustomerId: 1, ExternalImportReference: 'basis-1', Lines: [{ Quantity: 10, UnitPrice: 150 }] }) };
    assert.equal((await fetch(base+'/v2/SalesOrders', request)).status, 201);
    assert.equal((await fetch(base+'/v2/SalesOrders', request)).status, 409);
    const found = await (await fetch(base+'/v2/SalesOrders?externalImportReferences=basis-1')).json();
    assert.equal(found.length, 1); assert.equal(found[0].TotalAmount, 1500);
    const stats = await (await fetch(base+'/stats')).json();
    assert.equal(stats.mode, 'simulated'); assert.equal(stats.orders, 1); assert.equal(stats.duplicateReferences, 1);
  });
});

test('quota and injected failures are observable unsuccessful requests', async () => {
  await withServer({ latencyMs: 0, jitterMs: 0, requestsPerSecond: 2, failureEvery: 2 }, async (base) => {
    assert.equal((await fetch(base+'/OAuth/Token')).status, 200);
    assert.equal((await fetch(base+'/OAuth/Token')).status, 503);
    const limited = await fetch(base+'/OAuth/Token');
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
    const stats = await (await fetch(base+'/stats')).json();
    assert.equal(stats.injectedFailures, 1); assert.equal(stats.throttled, 1);
  });
});
