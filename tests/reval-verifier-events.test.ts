import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runVerifier } from '../packages/reval/verifier-exec.ts';

// R-EVAL RS-C-A carried RS-B item N4: the verifier V's pg client may emit an asynchronous 'error' (the server terminated the
// session: idle/statement timeout, administrator kill). V must absorb the event and still answer with a fixed refusal instead of
// crashing before its result (which C would misattribute). Pure: a fake client that emits 'error' and fails its query.
class TerminatedClient extends EventEmitter {
  async query(): Promise<{ rows: Record<string, unknown>[] }> {
    const e = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });
    setImmediate(() => this.emit('error', e)); // like pg: the socket error is emitted on the client, outside the query promise
    await new Promise(r => setImmediate(r));
    throw e;
  }
  async end(): Promise<void> { /* closed */ }
}

test('an asynchronous client error during V\'s first statement is absorbed: REFUSED INTERNAL_FAILURE, no crash', async () => {
  const request = { contractVersion: 'RevalFixtureVerifyRequestV1', helloNonce: randomUUID(), challenge: randomUUID(), remainingMs: 800, registrationId: randomUUID(),
    databaseInstanceId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor-reval', admissionId: randomUUID(),
    fixtureId: 'FX02', fixtureGeneration: '1', endpoint: { socketDir: '/tmp', port: 5432, database: 'atlas' }, runtimeRole: 'atlas_runtime',
    physical: { systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3', postmasterPid: '4', dataDirectory: '/d', socketDevice: '5', socketInode: '6' },
    runtimeSecretFile: '/tmp/unused' } as never;
  const client = new TerminatedClient();
  const out = await runVerifier(request, performance.now() + 800, { readSecret: async () => Buffer.from('synthetic'), connect: async () => client as never },
    () => performance.now());
  await new Promise(r => setImmediate(r));
  assert.deepEqual([out.outcome, out.code], ['REFUSED', 'INTERNAL_FAILURE']);
  assert.equal(client.listenerCount('error'), 1, 'V registered exactly one error listener');
});
