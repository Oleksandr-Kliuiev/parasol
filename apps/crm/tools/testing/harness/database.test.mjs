import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, prepareSqlLogins, removeOwnedContainer } from './database.mjs';

const state = { runId: '0123456789ab', sqlContainer: 'parasol-harness-0123456789ab-sql', sqlDatabase: 'crm_e2e_finance_0123456789ab',
  ports: { sql: 15433 }, directory: '/nonexistent/parasol-harness-run', sqlSaPassword: 'a'.repeat(40) };

test('SQL helpers refuse working databases, foreign containers and unsafe login passwords before any Docker call', async () => {
  for (const database of ['Crm', 'crm_e2e', 'msdb']) await assert.rejects(sql(state, 'SELECT 1;', database), /non-fixture SQL database/);
  for (const name of ['user-sql-container', 'parasol-harness-ba9876543210-sql'])
    await assert.rejects(removeOwnedContainer(state, name), /foreign database container/);
  for (const password of ["Aa1!';DROP LOGIN [sa];--" + 'a'.repeat(32), 'Aa1!short', undefined])
    await assert.rejects(prepareSqlLogins({ ...state, sqlWebPassword: password, sqlWorkerPassword: 'b'.repeat(40) }), /Invalid generated test password/);
});
