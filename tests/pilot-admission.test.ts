import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../packages/core/contracts.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import { ClientCredentialsTokenProvider } from '../connectors/microsoft365/auth.ts';
import { OPERATOR_COMMANDS } from '../packages/ops/commands.ts';
import { admitPilotAuthority, assertCleanProcess, PILOT_COMMANDS, validatePilotConfig } from '../packages/ops/pilot/config.ts';
import { composePilotContext, runPilot } from '../packages/ops/pilot/driver.ts';
import type { RuntimeDatabase } from '../packages/m365/maintenance.ts';
import { createRecorder } from '../packages/ops/pilot/recorder.ts';
import { CANARY, memorySink, pilotConfig, scriptedDispatch, tempDir } from './support/pilot-support.ts';

// Pilot admission before any database or upstream I/O: clean process, private config shape, the command allowlist (checked
// before the accepted flag parser), approved scope, fixture-namespace refusal, output collisions; refusing config/runtime
// callbacks; pilot authority extras. No database is reachable here: the runtime URL points to a reserved .invalid host.
const failsWith = (code: string) => (error: unknown) => error instanceof AtlasError && error.code === code;
const tmp = tempDir();
after(() => tmp.close());
const env = { ATLAS_RUNTIME_DATABASE_URL: 'postgresql://pilot:x@pilot-never-connects.invalid:5432/none', ATLAS_OPERATOR_TOKEN: `atl_${'a'.repeat(43)}` };
const flags = (extra: Record<string, string> = {}) => ({ client: 'pilot-client', connection: 'pilot-m365', ...extra });
const valid = (command = 'm365-status', f: Record<string, string> = flags()) => pilotConfig(command, f, ['pilot-m365'], tmp.path(`r-${Math.random()}.jsonl`));

test('a clean process only: NODE_OPTIONS, preloads/loaders and test-harness variables are refused', () => {
  assert.doesNotThrow(() => assertCleanProcess({}, ['--experimental-strip-types']));
  for (const argv of [['--import', './x.ts'], ['--require', 'x'], ['-r', 'x'], ['--loader', 'x'], ['--experimental-loader=x'], ['--import=x'], ['--inspect']]) {
    assert.throws(() => assertCleanProcess({}, argv), failsWith('PILOT_PRELOAD_REFUSED'), argv.join(' '));
  }
  assert.throws(() => assertCleanProcess({ NODE_OPTIONS: '--max-old-space-size=256' }, []), failsWith('PILOT_PRELOAD_REFUSED'));
  assert.throws(() => assertCleanProcess({ ATLAS_TEST_M365_PRELOAD_DIR: '/tmp/x' }, []), failsWith('PILOT_TEST_ENVIRONMENT_REFUSED'));
});

test('command allowlist: every other operator command is refused before its flags are even parsed', () => {
  const others = OPERATOR_COMMANDS.filter(c => !(PILOT_COMMANDS as readonly string[]).includes(c));
  assert.deepEqual([...others].sort(), ['bind', 'decisions-smoke', 'inbox', 'm365-cleanup', 'm365-directory-reset', 'm365-disable', 'm365-requeue',
    'reject-link', 'requeue', 'shadow-once', 'telemetry', 'triage', 'worker-once'].sort());
  for (const command of [...others, 'unknown', '__proto__', 'M365-PROBE']) {
    assert.throws(() => validatePilotConfig(valid(command, { client: 'pilot-client', bogus: 'x' })), failsWith('PILOT_COMMAND_REFUSED'), command);
  }
  for (const command of PILOT_COMMANDS) assert.throws(() => validatePilotConfig(valid(command, { client: 'pilot-client', bogus: 'x' })), failsWith('INVALID_ARGUMENTS'));
});

test('config shape, accepted flag rules, approved scope and the stock fixture namespace', () => {
  const ok = validatePilotConfig(valid('m365-sync', flags({ resource: 'signins', from: '2026-10-08T10:00:00Z', to: '2026-10-08T11:00:00Z' })));
  assert.deepEqual([ok.command, ok.invocation.flags.resource, ok.scope.connectionIds, ok.output.private], ['m365-sync', 'signins', ['pilot-m365'], null]);
  const bad: [unknown, string][] = [
    [null, 'PILOT_CONFIG_INVALID'], [[], 'PILOT_CONFIG_INVALID'], [{ ...valid(), version: 2 }, 'PILOT_CONFIG_INVALID'], [{ ...valid(), actor: 'demo-operator' }, 'PILOT_CONFIG_INVALID'],
    [{ ...valid(), flags: { client: 'pilot-client', connection: 7 } }, 'PILOT_CONFIG_INVALID'], [{ ...valid(), scope: { client: 'pilot-client', connections: ['pilot-m365'], permissions: ['m365:read'] } }, 'PILOT_CONFIG_INVALID'],
    [{ ...valid(), output: { receipts: 'relative.jsonl' } }, 'PILOT_CONFIG_INVALID'], [{ ...valid(), output: { receipts: '/tmp/a', private: '/tmp/a' } }, 'PILOT_CONFIG_INVALID'],
    [{ ...valid(), output: { receipts: '/tmp/a', origin: 'https://example.invalid' } }, 'PILOT_CONFIG_INVALID'],
    [valid('m365-sync', flags({ resource: 'signins', from: '2026-10-08T10:00:00Z' })), 'INVALID_ARGUMENTS'],
    [valid('m365-status', flags({ connection: 'other-m365' })), 'PILOT_SCOPE_MISMATCH'], [{ ...valid(), scope: { client: 'other-client', connections: ['pilot-m365'] } }, 'PILOT_SCOPE_MISMATCH'],
    [pilotConfig('mapping', { client: 'demo-gasta' }, [], '/tmp/x'), 'PILOT_FIXTURE_SCOPE_REFUSED'],
    [pilotConfig('live-read', { client: 'pilot-client', connection: 'demo-atera-connection' }, ['demo-atera-connection'], '/tmp/x'), 'PILOT_FIXTURE_SCOPE_REFUSED'],
  ];
  for (const [config, code] of bad) assert.throws(() => validatePilotConfig(config), failsWith(code), JSON.stringify(config));
});

test('pilot authority: never the demo workspace; mapping needs m365:read on the SAME membership; other gaps stay with the accepted (audited) boundary', () => {
  const actor = (workspaceId: string, memberships: Actor['memberships']): Actor => ({ id: 'op', workspaceId, workspacePermissions: [], memberships });
  const mapping = validatePilotConfig(pilotConfig('mapping', { client: 'pilot-client' }, [], '/tmp/x'));
  assert.throws(() => admitPilotAuthority(actor('demo-vardahei', [{ clientId: 'pilot-client', permissions: ['mapping:review', 'm365:read'] }]), mapping),
    failsWith('PILOT_FIXTURE_SCOPE_REFUSED'));
  assert.throws(() => admitPilotAuthority(actor('pilot-ws', [{ clientId: 'pilot-client', permissions: ['mapping:review'] }, { clientId: 'other', permissions: ['m365:read'] }]), mapping),
    failsWith('PILOT_AUTHORITY_REFUSED'), 'never combined across clients');
  assert.doesNotThrow(() => admitPilotAuthority(actor('pilot-ws', [{ clientId: 'pilot-client', permissions: ['mapping:review', 'm365:read'] }]), mapping));
  assert.doesNotThrow(() => admitPilotAuthority(actor('pilot-ws', [{ clientId: 'other', permissions: ['mapping:review', 'm365:read'] }]), mapping),
    'no membership: the accepted boundary refuses it and writes its security audit');
});

test('composed context: recorded transports only; config()/runtime() refuse and mark the run incomplete; no provider is constructible', async () => {
  const mem = memorySink();
  const fake = scriptedDispatch(() => new Response('{}'));
  const recorder = createRecorder({ sink: mem.sink, dispatch: fake.dispatch });
  const ctx = composePilotContext({} as PrismaClient, {} as RuntimeDatabase, { id: 'op', workspaceId: 'pilot-ws', workspacePermissions: [], memberships: [] }, recorder,
    { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://X', X: 'y'.repeat(40) });
  assert.equal(ctx.io.transport, recorder.stage1);
  const io = ctx.m365!.io();
  assert.ok(io.graph === recorder.graph && io.tokens instanceof ClientCredentialsTokenProvider && ctx.m365!.io() === io);
  assert.throws(() => ctx.config(), failsWith('PILOT_CALLBACK_REFUSED'));
  assert.throws(() => ctx.runtime(), failsWith('PILOT_CALLBACK_REFUSED'));
  const snap = recorder.snapshot();
  assert.deepEqual([snap.complete, snap.refusals.callback, snap.incompleteReasons, fake.calls.length], [false, 2, ['CALLBACK_REFUSED'], 0]);
});

test('runPilot refuses before any output, database or network: unsupported commands, preloads, bad configs, missing environment, collisions', async () => {
  const before = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; return Promise.reject(new Error('no network in this test')); }) as typeof fetch;
  try {
    const run = async (config: unknown, extraEnv: Record<string, string | undefined> = {}, execArgv: string[] = []) => {
      const path = tmp.write(`c-${Math.random()}.json`, config);
      return runPilot({ argv: ['--config', path], env: { ...env, ...extraEnv }, execArgv });
    };
    const expect = async (promise: ReturnType<typeof run>, code: string) => {
      const { exitCode, summary } = await promise;
      assert.deepEqual([exitCode, summary.status, summary.safeErrorCode, summary.recording, summary.result], [2, 'REFUSED', code, null, null], code);
      return summary;
    };
    for (const command of ['worker-once', 'shadow-once', 'decisions-smoke', 'bind', 'telemetry', 'm365-cleanup', 'm365-disable']) {
      const config = valid(command, { client: 'pilot-client' });
      await expect(run(config, { OPENAI_API_KEY: CANARY.secret }), 'PILOT_COMMAND_REFUSED');
      assert.equal(existsSync(config.output.receipts), false, 'no receipts file for a refused command');
    }
    await expect(run(valid(), { NODE_OPTIONS: '--max-old-space-size=256' }), 'PILOT_PRELOAD_REFUSED');
    await expect(run(valid(), {}, ['--import', './tests/support/m365-fetch-preload.ts']), 'PILOT_PRELOAD_REFUSED');
    await expect(run('{not json'), 'PILOT_CONFIG_INVALID');
    await expect(run(valid(), { ATLAS_OPERATOR_TOKEN: '' }), 'PILOT_RUNTIME_ENVIRONMENT_MISSING');
    await expect(run(valid('m365-directory', flags({ resource: 'users' }))), 'CORRELATION_CURSOR_CONFIG_INVALID');
    await expect(runPilot({ argv: ['--config', 'relative.json'], env, execArgv: [] }), 'PILOT_USAGE');
    await expect(runPilot({ argv: ['m365-status', '--client', 'pilot-client'], env, execArgv: [] }), 'PILOT_USAGE');
    await expect(runPilot({ argv: ['--config', tmp.path('missing.json')], env, execArgv: [] }), 'PILOT_CONFIG_UNREADABLE');
    const existing = tmp.write('existing-receipts.jsonl', 'earlier evidence\n');
    const summary = await expect(run({ ...valid(), output: { receipts: existing } }), 'PILOT_OUTPUT_EXISTS');
    assert.equal(readFileSync(existing, 'utf8'), 'earlier evidence\n', 'an existing report is never overwritten');
    assert.ok(!JSON.stringify(summary).includes(tmp.dir), 'no private path in public output');
    writeFileSync(tmp.path('p.json'), 'x');
    await expect(run({ ...valid(), output: { receipts: tmp.path('fresh.jsonl'), private: tmp.path('p.json') } }), 'PILOT_OUTPUT_EXISTS');
    assert.equal(existsSync(tmp.path('fresh.jsonl')), false, 'collision detected before either file is created');
    assert.equal(fetches, 0, 'zero network calls');
    assert.equal(globalThis.fetch === before, false, 'the spy stayed installed: no guard was installed or restored over it');
  } finally { globalThis.fetch = before; }
});
