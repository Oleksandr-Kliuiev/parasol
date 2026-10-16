import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireCompletePass } from './test-result.mjs';
const counts = { tests: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
const report = overrides => [{ type: 'test:summary', counts: { ...counts, ...overrides } }];
test('accepts a complete run, never a failure, skip, todo, cancellation or partial report', () => {
  assert.deepEqual(requireCompletePass(report({}), 0), counts);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.throws(() => requireCompletePass(report({ [key]: 1 }), 0));
  for (const exit of [1, null]) assert.throws(() => requireCompletePass(report({}), exit));
  for (const events of [[], report({ tests: 0 }), report({ passed: 1 }), [...report({}), { type: 'test:fail' }]]) {
    assert.throws(() => requireCompletePass(events, 0));
  }
});

import { requireBrowserPass } from './test-result.mjs';
test('browser acceptance rejects skipped tests, retries, empty results and global errors', () => {
  const report = { stats: { expected: 3, unexpected: 0, skipped: 0, flaky: 0 }, errors: [] };
  assert.deepEqual(requireBrowserPass(report, 0), report.stats);
  for (const key of ['unexpected', 'skipped', 'flaky']) assert.throws(() => requireBrowserPass({ ...report, stats: { ...report.stats, [key]: 1 } }, 0));
  for (const bad of [{}, { ...report, stats: { ...report.stats, expected: 0 } }, { ...report, errors: ['setup failed'] }]) {
    assert.throws(() => requireBrowserPass(bad, 0));
  }
  assert.throws(() => requireBrowserPass(report, 1));
});
