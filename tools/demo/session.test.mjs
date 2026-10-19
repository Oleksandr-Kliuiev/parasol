import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../composition/config.mjs';
import { demoDescriptor, parseDemoArgs, waitForDemoStop } from './session.mjs';
import { runDemo } from './run.mjs';

const fixture = () => ({
  runId: '0123456789ab', baseUrl: 'https://localhost:15443', target: { customerId: '12345678-1234-1234-1234-123456789abc' },
  counts: { clients: 40, devices: 400, employees: 3 },
  employees: ['Crm.Admin', 'Crm.Technician', 'Crm.ServiceLead'].map(role => ({ role, token: 'synthetic-private-value' })),
  privileges: { crmWebRestricted: true, crmWorkerRestricted: true, atlasRuntimeRestricted: true },
  sqlSaPassword: 'synthetic-private-value', private: { providerKey: 'synthetic-private-value' },
});

test('demo CLI accepts only a fresh absolute directory and a bounded whole-minute duration', () => {
  assert.deepEqual(parseDemoArgs(['--directory', '/tmp/parasol-demo']), { directory: '/tmp/parasol-demo', minutes: 30 });
  assert.deepEqual(parseDemoArgs(['--minutes', '120', '--directory', '/tmp/parasol-demo']), { directory: '/tmp/parasol-demo', minutes: 120 });
  for (const value of ['0', '-1', '1.5', '121', '01', 'NaN', 'Infinity'])
    assert.throws(() => parseDemoArgs(['--directory', '/tmp/parasol-demo', '--minutes', value]));
  for (const args of [[], ['--directory', 'relative'], ['--directory', '/tmp/../demo'], ['--directory', '/tmp/demo/'],
    ['--directory', '/tmp/demo', '--directory', '/tmp/other'], ['--directory', '/tmp/demo', '--skip-build'],
    ['--directory', '/tmp/demo', '--sql-image', 'foreign'], ['--minutes']]) assert.throws(() => parseDemoArgs(args));
});

test('public demo guide includes fixed local role links and expiry without serializing private fields', () => {
  const data = demoDescriptor(fixture(), 30, Date.UTC(2026, 9, 17, 12));
  assert.equal(data.expiresAt, '2026-10-17T12:30:00.000Z'); assert.equal(data.startedAt, '2026-10-17T12:00:00.000Z');
  assert.equal(data.workingProvidersConnected, false); assert.equal(data.restrictedRuntimes, true);
  assert.equal(JSON.stringify(data).includes('synthetic-private-value'), false);
  assert.equal(data.logins.length, 3);
  for (const link of data.logins) {
    const url = new URL(link.url); assert.equal(url.origin, data.baseUrl); assert.equal(url.pathname, '/bff/dev-login');
    assert.equal(url.searchParams.get('role'), link.role); assert.equal(url.searchParams.get('returnUrl'), '/');
  }
});

test('demo guide refuses foreign URL parts, incomplete scale and widened runtime privileges', () => {
  for (const baseUrl of ['http://localhost:15443', 'https://working.invalid:15443', 'https://user:password@localhost:15443',
    'https://localhost:15443/path', 'https://localhost:15443/?token=private', 'https://localhost:15443/#private'])
    assert.throws(() => demoDescriptor({ ...fixture(), baseUrl }, 30));
  for (const key of ['crmWebRestricted', 'crmWorkerRestricted', 'atlasRuntimeRestricted']) {
    const f = fixture(); f.privileges[key] = false; assert.throws(() => demoDescriptor(f, 30));
  }
  const f = fixture(); f.employees[1].role = 'Crm.Admin'; assert.throws(() => demoDescriptor(f, 30));
  assert.throws(() => demoDescriptor({ ...fixture(), counts: { clients: 39, devices: 400, employees: 3 } }, 30));
  assert.throws(() => demoDescriptor(fixture(), 0));
});

test('deadline completes the hold and removes its abort listener', async () => {
  const controller = new AbortController();
  assert.equal(await waitForDemoStop(controller.signal, 10), 'timeout');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an interrupt clears its long timer/listener and already interrupted sessions return immediately', async () => {
  const controller = new AbortController(); const stop = waitForDemoStop(controller.signal, 60_000);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1); controller.abort();
  assert.equal(await stop, 'interrupted'); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(await waitForDemoStop(controller.signal, 60_000), 'interrupted');
  for (const duration of [0, -1, 0.5, Infinity, 120 * 60_000 + 1]) assert.throws(() => waitForDemoStop(controller.signal, duration));
});

test('demo never overwrites an existing directory or its session descriptor', async () => {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'parasol-existing-demo-'));
  try {
    await writeFile(join(path, 'demo.json'), 'existing-user-file');
    await assert.rejects(runDemo({ directory: path, minutes: 1 }), { code: 'EEXIST' });
    assert.equal(await readFile(join(path, 'demo.json'), 'utf8'), 'existing-user-file');
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('all fixture host configurations keep working providers and outbound channels disabled', () => {
  const state = { directory: '/tmp/synthetic-owned-demo', ports: { sql: 15433 }, employees: [], atlasBridgeUrl: 'http://127.0.0.1:15444' };
  for (const host of ['web', 'worker', 'migrate']) {
    const config = appConfig(state, host, true);
    for (const name of ['Atera', 'PowerOffice', 'MicrosoftGraph', 'PartnerCenter']) {
      assert.equal(config.Integrations[name].Enabled, false);
      assert.equal(new URL(config.Integrations[name].BaseUrl).hostname, '127.0.0.1');
    }
    assert.equal(config.Notifications.EmailEnabled, false); assert.equal(config.Sales.EmailEnabled, false);
    assert.equal(config.Integrations.MicrosoftGraph.Teams.Enabled, false);
    assert.equal(config.Integrations.Atera.WriteEnabled, false); assert.equal(config.Integrations.PowerOffice.WriteEnabled, false);
  }
});
