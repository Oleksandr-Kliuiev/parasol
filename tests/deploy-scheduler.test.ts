import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor, parseJobs, signinWindow } from '../scripts/scheduler.ts';

// Deployment scheduler (scripts/scheduler.ts): schedule parsing, the closed-hour sign-in window and the exact accepted CLI commands.
const NOW = Date.parse('2026-10-13T17:25:00.000Z');

test('ATLAS_SYNC_JOBS: kinds with their arguments and intervals; anything malformed refuses', () => {
  const jobs = parseJobs('live-read:vardahei-it:vardahei-atera@15m; m365-directory:vardahei-it:vardahei-m365@6h;m365-signins:vardahei-it:vardahei-m365@1h; worker@5m', NOW);
  assert.deepEqual(jobs.map(j => [j.kind, j.client ?? null, j.connection ?? null, j.everyMs, j.due]), [
    ['live-read', 'vardahei-it', 'vardahei-atera', 900_000, NOW], ['m365-directory', 'vardahei-it', 'vardahei-m365', 21_600_000, NOW],
    ['m365-signins', 'vardahei-it', 'vardahei-m365', 3_600_000, NOW], ['worker', null, null, 300_000, NOW]]);
  for (const bad of [undefined, ' ', 'live-read:c@15m', 'worker:c@5m', 'live-read:c:n@0m', 'live-read:c:n@15s', 'sync:c:n@1h', 'live-read:C:n@1h', 'live-read:c:n']) {
    assert.throws(() => parseJobs(bad, NOW), /ATLAS_SYNC_JOBS/, String(bad));
  }
});

test('sign-in window: closed hours lagging one hour, continuing from the last run, at most 24 h; nothing new is no command', () => {
  const [job] = parseJobs('m365-signins:c:n@1h', NOW);
  assert.deepEqual(signinWindow(job!, NOW), { from: Date.parse('2026-10-13T14:00:00Z'), to: Date.parse('2026-10-13T16:00:00Z') }, 'first run: two closed hours');
  job!.signinsFrom = Date.parse('2026-10-13T16:00:00Z');
  assert.equal(signinWindow(job!, NOW), null, 'the next hour is not closed yet');
  assert.deepEqual(commandsFor(job!, NOW), []);
  job!.signinsFrom = Date.parse('2026-10-10T00:00:00Z');
  assert.deepEqual(signinWindow(job!, NOW), { from: Date.parse('2026-10-12T16:00:00Z'), to: Date.parse('2026-10-13T16:00:00Z') }, 'a long gap is capped at 24 h');
});

test('commands: exactly the accepted operator CLI invocations', () => {
  const jobs = parseJobs('live-read:c:a@15m;m365-directory:c:m@6h;m365-signins:c:m@1h;worker@5m', NOW);
  assert.deepEqual(jobs.map(j => commandsFor(j, NOW)), [
    [['live-read', '--client', 'c', '--connection', 'a']],
    [['m365-sync', '--client', 'c', '--connection', 'm', '--resource', 'users'], ['m365-sync', '--client', 'c', '--connection', 'm', '--resource', 'devices']],
    [['m365-sync', '--client', 'c', '--connection', 'm', '--resource', 'signins', '--from', '2026-10-13T14:00:00.000Z', '--to', '2026-10-13T16:00:00.000Z']],
    [['worker-once']]]);
});
