import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readinessErrorCode, sqlReadinessLabel } from './database.mjs';
import { failureLabel } from './run.mjs';

test('readiness diagnostics expose only constrained codes and fixed SQL labels', () => {
  assert.equal(readinessErrorCode({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(readinessErrorCode({ code: '28P01' }), '28P01');
  assert.equal(readinessErrorCode({ code: 'Password=synthetic-private' }), 'UNCLASSIFIED');
  assert.equal(readinessErrorCode(new Error('postgresql://synthetic:private@localhost/db')), 'UNCLASSIFIED');
  assert.equal(sqlReadinessLabel(new Error('Owned database operation failed (1); inspect its redacted stage log.')), 'SQL_COMMAND_FAILED');
  assert.equal(sqlReadinessLabel(new Error('Refusing a foreign database container.')), 'SQL_CONTAINER_GUARD_FAILED');
  assert.equal(sqlReadinessLabel(new Error('Password=synthetic-private')), 'SQL_PROBE_FAILED');
});
test('run failure labels retain safe status information without raw application or driver text', () => {
  assert.equal(failureLabel(new Error('CRM database migrations failed (1); inspect its redacted stage log.')), 'COMMAND_EXIT_1');
  assert.equal(failureLabel(new Error('Real CRM bootstrap endpoint failed with HTTP 403.')), 'CRM_BOOTSTRAP_HTTP_403');
  assert.equal(failureLabel(new Error('CRM Web exited before readiness.')), 'OWNED_APPLICATION_EXITED');
  assert.equal(failureLabel(new Error('Password=synthetic-private')), 'UNCLASSIFIED_STAGE_FAILURE');
  assert.equal(failureLabel({ code: 'postgresql://private' }), 'UNCLASSIFIED_STAGE_FAILURE');
  assert.equal(failureLabel({ code: 'ECONNRESET' }), 'DRIVER_ECONNRESET');
  assert.equal(failureLabel(new Error('private'), true), 'RUN_INTERRUPTED');
});
