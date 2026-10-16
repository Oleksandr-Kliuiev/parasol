import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './atlas-baseline.mjs';
const cwd = '/atlas';
const baseline = { minimumTests: 1, failures: [{ file: 'tests/a.ts', name: 'old', messageIncludes: 'DRIFT', diagnosticIncludes: 'CORPUS' }] };
const failure = { type: 'test:fail', file: '/atlas/tests/a.ts', name: 'old', error: { message: 'DRIFT' } };
const log = { type: 'test:stderr', file: failure.file, message: 'CORPUS' };
const summary = (failed, cancelled = 0) => ({ type: 'test:summary', counts: { tests: 1, failed, cancelled } });
test('accepts only the named failure with its expected error and diagnostic', () => {
  assert.deepEqual(evaluate([failure, log, summary(1)], baseline, cwd, 1).issues, []);
  for (const events of [[{ ...failure, name: 'new' }, log, summary(1)], [failure, summary(1)],
    [{ ...failure, error: { message: 'other crash' } }, log, summary(1)], [failure, failure, log, summary(2)]]) {
    assert.ok(evaluate(events, baseline, cwd, 1).issues.length);
  }
});
test('rejects truncation, cancellation, count mismatch and runner failure', () => {
  for (const [events, status] of [[[], 0], [[summary(0, 1)], 0], [[summary(1)], 1], [[summary(0)], null]]) {
    assert.ok(evaluate(events, baseline, cwd, status).issues.length);
  }
});
test('a complete all-pass run is accepted', () => {
  assert.deepEqual(evaluate([summary(0)], baseline, cwd, 0).issues, []);
});
