import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { parseInvocation } from '../packages/ops/commands.ts';
import { cleanupTimeoutMs, resolveRunnerUrl, runnerUrlFor } from '../packages/m365/maintenance.ts';
import { assertConfinedRunner } from '../packages/m365/maintenance-role.ts';
import type { RunnerRoleFacts } from '../packages/m365/maintenance-role.ts';

// Frozen CLI flag contract of the M365 commands and the cleanup runner configuration, without a database: parse-time mode
// and format rules, the 512-ASCII exception of the cursor flag only, and the runner target binding (identical complete
// target, only the credentials substituted into the RUNTIME URL), the bounded timeout and the confinement facts.
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const base = ['--client', 'demo-gasta', '--connection', 'gasta-m365'];

test('M365 commands: required flags, mutually exclusive modes, formats; cursor alone may be 512 ASCII characters', () => {
  assert.deepEqual(parseInvocation(['m365-sync', ...base, '--resource', 'users']).flags, { client: 'demo-gasta', connection: 'gasta-m365', resource: 'users' });
  assert.deepEqual(parseInvocation(['m365-sync', ...base, '--resource', 'signins', '--from', '2026-10-08T00:00:00Z', '--to', '2026-10-08T01:00:00.000Z']).command, 'm365-sync');
  assert.deepEqual(parseInvocation(['m365-sync', ...base, '--resource', 'signins', '--request', 'req-1']).flags.request, 'req-1');
  assert.deepEqual(parseInvocation(['m365-cleanup', '--client', 'demo-gasta']).flags, { client: 'demo-gasta' });
  const cursor = `${'A'.repeat(468)}.${'B'.repeat(43)}`;
  assert.equal(parseInvocation(['m365-directory', ...base, '--resource', 'devices', '--limit', '100', '--cursor', cursor]).flags.cursor, cursor);
  assert.equal(parseInvocation(['correlation', ...base, '--observation', 'o', '--from', '2026-10-08T00:00:00Z', '--to', '2026-10-08T01:00:00.1234567Z', '--cursor', cursor])
    .flags.cursor!.length, 512);
  for (const argv of [['m365-sync', ...base, '--resource', 'users', '--request', 'r'], ['m365-sync', ...base, '--resource', 'signins'],
    ['m365-sync', ...base, '--resource', 'signins', '--from', '2026-10-08T00:00:00Z'], ['m365-sync', ...base, '--resource', 'signins', '--request', 'bad id'],
    ['m365-sync', ...base, '--resource', 'signins', '--from', '2026-10-08T00:00:00.0001Z', '--to', '2026-10-08T01:00:00Z'],
    ['m365-sync', '--client', 'demo-gasta', '--connection', 'x'.repeat(257), '--resource', 'users'], ['m365-directory', ...base, '--resource', 'users', '--limit', '0'],
    ['m365-directory', ...base, '--resource', 'users', '--cursor', `A${cursor}`], ['m365-directory', ...base, '--resource', 'users', '--cursor', `${'ü'.repeat(4)}.${'B'.repeat(43)}`],
    ['m365-directory', ...base, '--resource', 'users', '--connection', 'again'], ['m365-status', ...base, '--resource', 'users'], ['m365-cleanup', '--client', 'demo-gasta', '--from', 'x'],
    ['m365-requeue', ...base, '--request', 'r', '--window', 'bad id'], ['m365-directory-reset', ...base, '--resource', 'signins'], ['m365-probe', '--client', 'demo-gasta'],
    ['correlation', ...base, '--observation', 'o', '--from', '2026-10-08T00:00:00Z'], ['m365-disable', ...base, '--cursor', cursor]]) {
    assert.throws(() => parseInvocation(argv), fails('INVALID_ARGUMENTS'), argv.join(' ').slice(0, 120));
  }
});

test('runner URL: the complete target must equal the runtime target; the URL used is the runtime URL with the runner credentials', () => {
  const runtime = 'postgresql://app:app-secret@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5';
  assert.equal(runnerUrlFor(runtime, 'postgresql://runner:runner-secret@DB.Example.Invalid/atlas?connection_limit=5&sslmode=require'),
    'postgresql://runner:runner-secret@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5');
  assert.equal(runnerUrlFor('postgresql://app:s@h/atlas', 'postgresql://runner:t@h:5432/atlas'), 'postgresql://runner:t@h/atlas', 'default port substitution both ways');
  for (const runner of ['postgresql://runner:t@other.example.invalid:5432/atlas?sslmode=require&connection_limit=5',
    'postgresql://runner:t@db.example.invalid:5433/atlas?sslmode=require&connection_limit=5', 'postgresql://runner:t@db.example.invalid:5432/atlas_b?sslmode=require&connection_limit=5',
    'postgresql://runner:t@db.example.invalid:5432/atlas?sslmode=disable&connection_limit=5', 'postgresql://runner:t@db.example.invalid:5432/atlas?sslmode=require',
    'postgres://runner:t@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5', 'postgresql://runner:t@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5#f',
    'postgresql://runner@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5', 'postgresql://app:other@db.example.invalid:5432/atlas?sslmode=require&connection_limit=5',
    'http://runner:t@db.example.invalid:5432/atlas', 'not a url']) {
    assert.throws(() => runnerUrlFor(runtime, runner), fails('M365_CLEANUP_CONFIG_INVALID'), runner);
  }
  assert.throws(() => resolveRunnerUrl(runtime, {}), fails('M365_CLEANUP_CONFIG_INVALID'));
  assert.throws(() => resolveRunnerUrl(runtime, { ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://R' }), fails('M365_CLEANUP_CONFIG_INVALID'));
  assert.throws(() => resolveRunnerUrl(runtime, { ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'postgresql://x' }), fails('M365_CLEANUP_CONFIG_INVALID'));
});

test('timeout: integer 30000..600000 ms, default 300000; confinement facts fail closed with one safe code', () => {
  assert.deepEqual([cleanupTimeoutMs({}), cleanupTimeoutMs({ ATLAS_M365_CLEANUP_TIMEOUT_MS: '30000' }), cleanupTimeoutMs({ ATLAS_M365_CLEANUP_TIMEOUT_MS: '600000' })],
    [300_000, 30_000, 600_000]);
  for (const v of ['29999', '600001', '3e4', ' 30000', '030000', '-30000']) assert.throws(() => cleanupTimeoutMs({ ATLAS_M365_CLEANUP_TIMEOUT_MS: v }), fails('M365_CLEANUP_CONFIG_INVALID'));
  const ok: RunnerRoleFacts = { superuser: false, bypassRls: false, sessionRoleMismatch: false, attributeViolations: 0, memberships: 0, members: 0, ownedRelations: 0,
    relationPrivileges: 0, routines: 1, canExecute: true, definerRoutine: true, ownerViolations: 0, ownerMissingGrants: 0, executeViolations: 0 };
  assertConfinedRunner(ok);
  for (const bad of [{ superuser: true }, { bypassRls: true }, { sessionRoleMismatch: true }, { attributeViolations: 1 }, { memberships: 1 }, { members: 1 },
    { ownedRelations: 1 }, { relationPrivileges: 1 }, { routines: 0 }, { canExecute: false }, { definerRoutine: false }, { ownerViolations: 1 }, { ownerMissingGrants: 1 },
    { executeViolations: 1 }]) assert.throws(() => assertConfinedRunner({ ...ok, ...bad }), fails('M365_CLEANUP_RUNNER_NOT_CONFINED'), JSON.stringify(bad));
  assert.throws(() => assertConfinedRunner(undefined), fails('M365_CLEANUP_RUNNER_NOT_CONFINED'));
});
