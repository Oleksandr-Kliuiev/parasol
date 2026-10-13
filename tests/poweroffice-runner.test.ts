import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { ANCHOR_RESERVE_MS, CLEANUP_BUDGET_MS, runnerFailure, startBudget } from '../packages/poweroffice/runner-transaction.ts';

// S4-C RC2 (Astra S4C-rc1 R1/R2): fixed classification of runner failures from STRUCTURED fields only (name, code,
// errorCode, SQLSTATE) and the original budget; messages are never parsed or echoed. The budget is fixed once and never reset.
const fresh = startBudget();
const spentBudget = { left: () => 0 };
const init = (errorCode: string) => Object.assign(new Error('private message with postgresql://user:secret@host 57014'), { name: 'PrismaClientInitializationError', errorCode });
const known = (sqlstate: string) => ({ name: 'PrismaClientKnownRequestError', code: 'P2010', clientVersion: '6.19.0', meta: { code: sqlstate } });

test('acquisition/login timeouts are CLEANUP_TIMEOUT; authentication and other initialization failures stay RUNTIME_NOT_READY', () => {
  for (const code of ['P2024', 'P1002', 'P1001']) assert.equal(runnerFailure(init(code), fresh), 'POWEROFFICE_CLEANUP_TIMEOUT', code);
  for (const code of ['P1000', 'P1003', 'P1010', 'P1011', undefined]) assert.equal(runnerFailure(init(code as string), fresh), 'POWEROFFICE_RUNTIME_NOT_READY', String(code));
  assert.equal(runnerFailure({ name: 'PrismaClientKnownRequestError', code: 'P2024' }, fresh), 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.equal(runnerFailure({ code: 'P2028' }, fresh), 'POWEROFFICE_CLEANUP_TIMEOUT');
});

test('server-side cancellations, conflicts and own outcomes map by SQLSTATE/code; text never decides', () => {
  for (const s of ['57014', '55P03', '25P03', '25P04']) assert.equal(runnerFailure(known(s), fresh), 'POWEROFFICE_CLEANUP_TIMEOUT', s);
  for (const s of ['40P01', '40001']) assert.equal(runnerFailure(known(s), fresh), 'POWEROFFICE_DB_CONFLICT', s);
  assert.equal(runnerFailure(known('PO010'), fresh), 'POWEROFFICE_CLEANUP_FAILED');
  assert.equal(runnerFailure(known('58000'), fresh), 'POWEROFFICE_CLEANUP_FAILED', 'audit failure');
  assert.equal(runnerFailure(new Error('canceling statement due to statement timeout 57014 25P04'), fresh), 'POWEROFFICE_CLEANUP_FAILED',
    'an unstructured error is never classified from its message');
  for (const code of ['POWEROFFICE_RUNTIME_NOT_READY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_CLEANUP_FAILED']) {
    assert.equal(runnerFailure(new AtlasError(code, 'PERMANENT'), fresh), code);
  }
});

test('a CODELESS failure observed in the original deadline window is a timeout (known SQLSTATEs: tests/poweroffice-runner-phases.test.ts)', () => {
  assert.equal(runnerFailure(new Error('connection closed'), spentBudget), 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.equal(runnerFailure(new Error('connection closed'), { left: () => ANCHOR_RESERVE_MS }), 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.equal(runnerFailure(new Error('connection closed'), { left: () => ANCHOR_RESERVE_MS + 1 }), 'POWEROFFICE_CLEANUP_FAILED');
});

test('the budget is fixed once from the start and only decreases', () => {
  let t = 1000;
  const b = startBudget(() => t);
  assert.equal(b.left(), CLEANUP_BUDGET_MS);
  t += 4000; assert.equal(b.left(), CLEANUP_BUDGET_MS - 4000);
  t += 7000; assert.ok(b.left() < 0);
});
