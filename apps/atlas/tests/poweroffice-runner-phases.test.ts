import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { ANCHOR_RESERVE_MS, connectFailure, runnerFailure, settingMs, startBudget } from '../packages/poweroffice/runner-transaction.ts';

// S4-C RC5 (Astra S4C-rc4 F1/F2; decision table in docs/stage4/S4C_RC5_IMPLEMENTATION_REPORT.md §2): FIRST-cause
// classification from the runner's own evidence — the first session terminal event (time, budget left, SQLSTATE if any),
// the caught failure (time, budget left), the effective server deadline armed at BEGIN and the watchdog fire time — never
// message text. A positively known SQLSTATE is never relabelled by any clock; only codeless causes use the timers.
// (Revises the RC4 version of this file, whose context fields `expired`/`serverDue`/`terminalState` no longer exist.)
const fresh = startBudget();
const generic = () => new Error('Connection terminated unexpectedly 25P04 57014'); // text never decides
const pgError = (state: string) => Object.assign(new Error('x'), { code: state });
const QUERY_FAILED = ['57P01', '42501', 'PO010', '58000', '23505'];
const CONFLICT = ['40P01', '40001'];
const TIMEOUT = ['57014', '55P03', '25P03', '25P04'];
const LEFTS = [ANCHOR_RESERVE_MS + 1, ANCHOR_RESERVE_MS, 0];

test('query SQLSTATEs at 251 / 250 / 0 ms left, with or without due timers: known causes keep their class', () => {
  for (const left of LEFTS) {
    for (const ctx of [{}, { failedLeft: left, serverDueAt: 0, firedAt: 0, failedAt: 10 }]) {
      const budget = { left: () => left };
      for (const s of QUERY_FAILED) assert.equal(runnerFailure(pgError(s), budget, ctx), 'POWEROFFICE_CLEANUP_FAILED', `${s} @${left}`);
      for (const s of CONFLICT) assert.equal(runnerFailure(pgError(s), budget, ctx), 'POWEROFFICE_DB_CONFLICT', `${s} @${left}`);
      for (const s of TIMEOUT) assert.equal(runnerFailure(pgError(s), budget, ctx), 'POWEROFFICE_CLEANUP_TIMEOUT', `${s} @${left}`);
    }
    assert.equal(runnerFailure(generic(), { left: () => left }), left <= ANCHOR_RESERVE_MS ? 'POWEROFFICE_CLEANUP_TIMEOUT' : 'POWEROFFICE_CLEANUP_FAILED',
      `codeless @${left}: only codeless causes use the original window`);
  }
});

test('session-terminal SQLSTATEs (first event) at 251 / 250 / 0 ms left decide over a later codeless failure', () => {
  for (const left of LEFTS) {
    const ctx = (state: string) => ({ terminal: { at: 5, left, state }, failedAt: 1500, failedLeft: 0, serverDueAt: 1000, firedAt: 1400 });
    for (const s of QUERY_FAILED) assert.equal(runnerFailure(generic(), fresh, ctx(s)), 'POWEROFFICE_CLEANUP_FAILED', `${s} @${left}`);
    for (const s of CONFLICT) assert.equal(runnerFailure(generic(), fresh, ctx(s)), 'POWEROFFICE_DB_CONFLICT', `${s} @${left}`);
    for (const s of TIMEOUT) assert.equal(runnerFailure(generic(), fresh, ctx(s)), 'POWEROFFICE_CLEANUP_TIMEOUT', `${s} @${left}`);
  }
});

test('codeless first causes use the time they were OBSERVED, not the later callback failure (F1)', () => {
  const later = { failedAt: 1519, failedLeft: 8481, serverDueAt: 1000 };
  assert.equal(runnerFailure(generic(), fresh, { ...later, terminal: { at: 8, left: 9992 } }), 'POWEROFFICE_CLEANUP_FAILED',
    'early generic loss before the effective timer stays a failure although the callback failed after it');
  assert.equal(runnerFailure(generic(), fresh, { ...later, terminal: { at: 1001, left: 8999 } }), 'POWEROFFICE_CLEANUP_TIMEOUT',
    'a generic loss observed at/after the effective timer is the timer');
  assert.equal(runnerFailure(generic(), fresh, later), 'POWEROFFICE_CLEANUP_TIMEOUT', 'no session event: the failure itself after the timer');
  assert.equal(runnerFailure(generic(), fresh, { failedAt: 900, failedLeft: 9100, serverDueAt: 1000 }), 'POWEROFFICE_CLEANUP_FAILED');
  assert.equal(runnerFailure(generic(), fresh, { failedAt: 9000, failedLeft: 1000, firedAt: 8999 }), 'POWEROFFICE_CLEANUP_TIMEOUT', 'after the watchdog');
  assert.equal(runnerFailure(generic(), fresh, { terminal: { at: 50, left: 9950 }, failedAt: 10_100, failedLeft: 0, firedAt: 10_000 }),
    'POWEROFFICE_CLEANUP_FAILED', 'an early loss is not relabelled by a later watchdog fire or window');
});

test('first-cause precedence: a later session event (e.g. during ROLLBACK) never overrides the caught failure; own codes keep precedence', () => {
  const lateEvent = (state?: string) => ({ terminal: { at: 2000, left: 8000, state }, failedAt: 1000, failedLeft: 9000, serverDueAt: 5000 });
  assert.equal(runnerFailure(pgError('42501'), fresh, lateEvent('25P04')), 'POWEROFFICE_CLEANUP_FAILED');
  assert.equal(runnerFailure(pgError('57014'), fresh, lateEvent('57P01')), 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.equal(runnerFailure(generic(), fresh, lateEvent('25P04')), 'POWEROFFICE_CLEANUP_FAILED', 'codeless failure before the timer; the later event is secondary');
  assert.equal(runnerFailure(generic(), fresh, { terminal: { at: 1000, left: 9000, state: '57P01' }, failedAt: 1000, failedLeft: 9000, serverDueAt: 900 }),
    'POWEROFFICE_CLEANUP_FAILED', 'equal times: the structured event is preferred over the codeless failure');
  for (const code of ['POWEROFFICE_RUNTIME_NOT_READY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_CLEANUP_FAILED']) {
    assert.equal(runnerFailure(new AtlasError(code, 'PERMANENT'), { left: () => 0 }, { failedLeft: 0, serverDueAt: 0, firedAt: 0, failedAt: 1 }), code, code);
  }
  assert.equal(runnerFailure(new AtlasError('POWEROFFICE_SYNC_BUSY', 'CONFLICT'), fresh, { terminal: { at: 1, left: 9999 }, failedAt: 2 }),
    'POWEROFFICE_CLEANUP_FAILED', 'an earlier transport loss is the first cause even before an own fixed code');
});

test('connect phase: known SQLSTATE decides at any remaining budget; codeless uses the own connect timer / window', () => {
  for (const left of LEFTS) {
    for (const s of ['28P01', '28000', '3D000', '57P03']) assert.equal(connectFailure(pgError(s), true, left), 'POWEROFFICE_RUNTIME_NOT_READY', `${s} @${left}`);
    for (const s of TIMEOUT) assert.equal(connectFailure(pgError(s), false, left), 'POWEROFFICE_CLEANUP_TIMEOUT', `${s} @${left}`);
    assert.equal(connectFailure(generic(), false, left), left <= ANCHOR_RESERVE_MS ? 'POWEROFFICE_CLEANUP_TIMEOUT' : 'POWEROFFICE_RUNTIME_NOT_READY');
  }
  assert.equal(connectFailure(generic(), true, 5000), 'POWEROFFICE_CLEANUP_TIMEOUT', 'own connect timer/watchdog closed it');
});

test('current_setting text → milliseconds for the three timeouts; unknown forms refuse', () => {
  assert.deepEqual(['0', '1500ms', '1s', '30s', '2min', '1h', '1d'].map(settingMs), [0, 1500, 1000, 30000, 120000, 3600000, 86400000]);
  for (const bad of ['', '1.5s', '-1', '30 s', 'abc', undefined, 5]) assert.equal(settingMs(bad), null, String(bad));
});
