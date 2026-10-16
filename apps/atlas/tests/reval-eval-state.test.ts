import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCaseFixtures } from '../packages/reval/eval-cases.ts';
import { preSnapshotProblem } from '../packages/reval/eval-controller.ts';
import { JournalError, TerminalJournal } from '../packages/reval/eval-journal.ts';
import { RETAIN_AFTER_RELEASE_MS, TerminalObserver } from '../packages/reval/eval-observer.ts';
import { DatasetError } from '../packages/reval/dataset.ts';
import { binding, terminal, TestClock } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A pure state (rs-c/IMPLEMENTATION_BRIEF.md §3, §5; 06 "Original-task terminal observation"): the terminal
// observer's latches/revisions/retention, the controller journal and case map, and the PRE snapshot checks (pair/arm/claim/slot:
// tests/reval-eval-pairing.test.ts). No process or database.
const ADMISSION = randomUUID();

test('terminal observer: created only with a Binding, ≤4 active; first fault + time latch; revisions only on change; final after release', () => {
  const clock = new TestClock(); const o = new TerminalObserver(clock);
  const b = binding();
  assert.ok(o.create(b) && !o.create(b), 'one record per arm');
  assert.equal(o.read(b.armId)?.revision, 1); assert.equal(o.read(b.armId)?.revision, 1, 'reads never revise');
  o.fault(b.armId, 'USAGE_INVALID'); const at = o.read(b.armId)!.detectedAt;
  clock.advance(5); o.fault(b.armId, 'UPSTREAM_AUTH');
  assert.deepEqual([o.read(b.armId)!.detectedFault, o.read(b.armId)!.detectedAt, o.read(b.armId)!.revision], ['USAGE_INVALID', at, 2]);
  o.reservation(b.armId, 'COMMITTED', randomUUID()); o.settlement(b.armId, 'CONFIRMED'); o.settlement(b.armId, 'FAILED_KNOWN');
  assert.deepEqual([o.read(b.armId)!.settlement, o.read(b.armId)!.revision], ['CONFIRMED', 4]);
  o.publication(b.armId, { state: 'PENDING', kind: 'NONE', status: null, code: null });
  o.released(b.armId);
  assert.deepEqual([o.read(b.armId)!.final, o.read(b.armId)!.physicalOwnerReleased], [false, true], 'a write in flight at release is not final yet');
  o.publication(b.armId, { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_MODEL_MISMATCH' });
  const fin = o.read(b.armId)!;
  assert.deepEqual([fin.final, fin.publication.state], [true, 'SERVER_FINISHED'], 'released + terminal publication → final');
  o.settlement(b.armId, 'COMMIT_UNKNOWN'); assert.equal(o.read(b.armId)!.revision, fin.revision, 'final never changes');
  assert.equal(o.priorCollected(), false);
  assert.equal(o.collected(b.armId, fin.observationId, fin.revision - 1), false, 'only the exact latest revision');
  assert.ok(o.collected(b.armId, fin.observationId, fin.revision) && o.priorCollected() && o.read(b.armId) === null);
  const many = new TerminalObserver(clock);
  for (let i = 0; i < 4; i += 1) assert.ok(many.create(binding()));
  assert.equal(many.create(binding()), false, '≤4 active records');
});

test('terminal observer coverage: >16 revisions and 10 min after release without collection are sticky coverage failures', () => {
  const clock = new TestClock(); const o = new TerminalObserver(clock);
  const b = binding(); o.create(b);
  for (let i = 0; i < 20; i += 1) o.publication(b.armId, i % 2 ? { state: 'PENDING', kind: 'NONE', status: null, code: null } : { state: 'NOT_ATTEMPTED', kind: 'NONE', status: null, code: null });
  assert.ok(o.read(b.armId) === null && o.coverageFailures > 0 && !o.priorCollected(), 'overflow → no NONE claim, arming blocked');
  const c2 = new TestClock(); const o2 = new TerminalObserver(c2); const b2 = binding(); o2.create(b2); o2.released(b2.armId);
  c2.advance(RETAIN_AFTER_RELEASE_MS + 1);
  assert.ok(o2.read(b2.armId) === null && o2.uncollectedTerminalCount === 1 && !o2.priorCollected());
});

test('controller journal: one fsynced 0600 line per validated record; refuses a symlink, a widened file, an invalid record (sticky) and the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-journal-')); chmodSync(dir, 0o700);
  const path = join(dir, 'reval-journal.jsonl'); const j = new TerminalJournal(path);
  const rec = terminal();
  const saved = j.save(rec, { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' });
  assert.deepEqual(saved, rec);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]!).contractVersion, 'RevalTerminalJournalV1');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => j.save({ ...rec, raw: 'x' }, { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' }), JournalError);
  assert.throws(() => j.save(terminal(), { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' }), JournalError, 'failure is sticky');
  assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 1, 'nothing partial was appended');
  const target = join(dir, 'elsewhere'); writeFileSync(target, '', { mode: 0o600 }); const link = join(dir, 'link.jsonl'); symlinkSync(target, link);
  assert.throws(() => new TerminalJournal(link).save(terminal(), { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' }), JournalError);
  const wide = join(dir, 'wide.jsonl'); writeFileSync(wide, '', { mode: 0o644 }); chmodSync(wide, 0o644);
  assert.throws(() => new TerminalJournal(wide).save(terminal(), { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' }), JournalError);
  const full = join(dir, 'full.jsonl'); writeFileSync(full, Buffer.alloc(32 * 1024 * 1024 - 10), { mode: 0o600 });
  assert.throws(() => new TerminalJournal(full).save(terminal(), { serverBootId: randomUUID(), receivedAt: '2026-10-11T12:00:00.000Z' }), JournalError);
});

test('case map: exactly 200 frozen cases → fixture IDs (no question text kept); a changed case byte refuses', () => {
  const m = loadCaseFixtures();
  assert.equal(m.size, 200);
  assert.ok([...m.values()].every(v => /^FX(0[1-9]|1[01])$/.test(v)));
  assert.equal([...m.values()].filter(v => v === 'FX10').length, 15);
  assert.ok([...m.keys()].every(k => k.length <= 64));
  const real = (name: string) => readFileSync(new URL(`../docs/stage5/ask/remote/eval/data/${name}`, import.meta.url));
  assert.throws(() => loadCaseFixtures(name => { const b = Buffer.from(real(name)); if (name.startsWith('cases-')) b[b.length - 2] ^= 1; return b; }), DatasetError);
});

test('PRE snapshot: fresh day/month, same admission/version/fixture, ACTIVE and unexpired, consistent, foreign 0, headroom ≥ reserve', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  const s = { snapshotId: randomUUID(), dbObservedAt: '2026-10-11T12:00:00.000Z', admissionId: ADMISSION, policyVersion: '3', fenceEpoch: '5', policyState: 'ACTIVE',
    reserveMicroUsd: '300000', dayCapMicroUsd: '2000000', monthCapMicroUsd: '10000000', expiresAt: '2026-10-12T12:00:00.000Z', currentDay: '2026-10-11',
    currentMonth: '2026-10-01', fixtureGeneration: '1', fixtureId: 'FX02', projectAttemptCount: '0', foreignScopeAttemptCount: '0', consistent: true,
    attempts: [], periods: [{ kind: 'DAY', periodStart: '2026-10-11', chargedMicroUsd: '1700000' }, { kind: 'MONTH', periodStart: '2026-10-01', chargedMicroUsd: '0' }] };
  const p = { admissionId: ADMISSION, policyVersion: '3', fixtureId: 'FX02', fixtureGeneration: '1' };
  assert.equal(preSnapshotProblem(s as never, p, ADMISSION, now), null, 'exactly at the day cap headroom');
  for (const [over, pover, code] of [[{ currentDay: '2026-10-10' }, {}, 'SNAPSHOT_STALE'], [{ currentMonth: '2026-09-01' }, {}, 'SNAPSHOT_STALE'],
    [{ admissionId: randomUUID() }, {}, 'POLICY_CHANGED'], [{}, { admissionId: randomUUID() }, 'POLICY_CHANGED'], [{ policyState: 'PAUSED' }, {}, 'ADMISSION_NOT_ACTIVE'],
    [{ expiresAt: '2026-10-11T12:00:00.000Z' }, {}, 'ADMISSION_NOT_ACTIVE'], [{ policyVersion: '4' }, {}, 'POLICY_CHANGED'], [{ fixtureGeneration: '2' }, {}, 'FIXTURE_MISMATCH'],
    [{ consistent: false }, {}, 'CENSUS_CHANGED_UNEXPECTEDLY'], [{ foreignScopeAttemptCount: '1' }, {}, 'CENSUS_CHANGED_UNEXPECTEDLY'],
    [{ periods: [{ kind: 'DAY', periodStart: '2026-10-11', chargedMicroUsd: '1700001' }] }, {}, 'ADMISSION_NOT_ACTIVE']] as const) {
    assert.equal(preSnapshotProblem({ ...s, ...over } as never, { ...p, ...pover }, ADMISSION, now), code, JSON.stringify(over));
  }
});
