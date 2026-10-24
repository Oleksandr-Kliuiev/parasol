import { test } from 'node:test';
import assert from 'node:assert/strict';
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
