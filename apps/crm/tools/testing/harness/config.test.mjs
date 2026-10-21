import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appConfig, connectionString } from './config.mjs';

test('CRM host configuration names only its owned loopback SQL login, disabled providers and web-only secrets', () => {
  const state = { directory: '/synthetic/run', sqlDatabase: 'crm_e2e_finance_0123456789ab', ports: { sql: 15433 },
    sqlSaPassword: 'a'.repeat(40), sqlWebPassword: 'b'.repeat(40), sqlWorkerPassword: 'c'.repeat(40),
    documentVolumeId: '00000000-0000-4000-8000-000000000001', certificatePath: '/synthetic/run/private/test.pfx', certificatePassword: 'd'.repeat(48) };
  const configs = { migrate: appConfig(state, 'migrate'), web: appConfig(state, 'web'), worker: appConfig(state, 'worker') };
  assert.equal(configs.migrate.ConnectionStrings.crm, connectionString(state, 'sa', state.sqlSaPassword));
  assert.equal(configs.web.ConnectionStrings.crm, connectionString(state, 'harness_web', state.sqlWebPassword));
  assert.equal(configs.worker.ConnectionStrings.crm, connectionString(state, 'harness_worker', state.sqlWorkerPassword));
  assert.match(configs.worker.ConnectionStrings.crm, /^Server=127\.0\.0\.1,15433;Database=crm_e2e_finance_0123456789ab;/);
  for (const config of Object.values(configs)) {
    // Only the sections the CRM hosts read; no other service is configured or reachable.
    assert.deepEqual(Object.keys(config).filter(key => !['AllowedHosts', 'ConnectionStrings', 'Auth', 'Documents', 'Hangfire', 'Database',
      'Logging', 'Kestrel', 'Notifications', 'Sales', 'Integrations', 'RateLimits', 'DataProtection'].includes(key)), []);
    assert.equal(Object.values(config.Integrations).some(provider => provider.Enabled || provider.WriteEnabled), false);
  }
  assert.equal(configs.migrate.Hangfire.PrepareSchema, true); assert.equal(configs.web.Hangfire.PrepareSchema, false);
  assert.equal('DataProtection' in configs.worker || 'Auth' in configs.worker, false);
  assert.equal(configs.web.DataProtection.KeyRingPath, '/synthetic/run/private/keyring');
});
