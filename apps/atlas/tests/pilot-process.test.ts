import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CANARY, pilotConfig, tempDir } from './support/pilot-support.ts';

// Actual `scripts/stage2-live-pilot.ts` processes, refused BEFORE any output file, database or upstream I/O: injected
// preloads (--import, NODE_OPTIONS, the S2-C mock fetch preload), test-harness variables and every non-allowlisted command.
// The runtime URL names a reserved .invalid host that is never contacted; stdout is one safe JSON object, stderr carries no
// canary and no private path. Synthetic values only.
const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = tempDir();
after(() => tmp.close());
const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined
  && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_|M365_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|DATABASE_URL)/.test(e[0])));
const baseEnv = { ATLAS_RUNTIME_DATABASE_URL: 'postgresql://pilot:x@pilot-never-connects.invalid:5432/none', ATLAS_OPERATOR_TOKEN: `atl_${'b'.repeat(43)}`,
  OPENAI_API_KEY: CANARY.secret, PILOT_M365_CREDENTIAL: `${CANARY.app}:${CANARY.secret}` };

async function pilot(config: unknown, env: Record<string, string> = {}, nodeArgs: string[] = []) {
  const path = tmp.write(`config-${Math.random()}.json`, config);
  const child = spawn(process.execPath, ['--experimental-strip-types', ...nodeArgs, 'scripts/stage2-live-pilot.ts', '--config', path],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, ...baseEnv, ...env } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += String(d); });
  child.stderr.on('data', d => { stderr += String(d); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  for (const text of [stdout, stderr]) {
    for (const canary of [CANARY.secret, CANARY.app, tmp.dir, 'pilot-client', 'pilot-m365', 'pilot-never-connects']) assert.ok(!text.includes(canary), canary);
  }
  return { code, output: JSON.parse(stdout) as Record<string, unknown>, stderr };
}
const config = (command = 'm365-status', flags: Record<string, string> = { client: 'pilot-client', connection: 'pilot-m365' }) =>
  pilotConfig(command, flags, ['pilot-m365'], tmp.path(`receipts-${Math.random()}.jsonl`));
const refusal = (code: string) => ({ pilot: 'atlas-stage2-live-pilot', version: 1, command: null, status: 'REFUSED', safeErrorCode: code, evidence: 'OPERATION_OUTCOME_ONLY',
  grants: [], recording: null, result: null, privateOutputWritten: false });

test('an injected --import preload, NODE_OPTIONS, the S2-C mock fetch preload or a test variable: refused with exit 2 before any output', async () => {
  const marker = tmp.path('preload-marker');
  const c = config();
  const preloaded = await pilot(c, { PILOT_PRELOAD_MARKER: marker }, ['--import', './tests/support/pilot-preload.ts']);
  assert.deepEqual([preloaded.code, preloaded.output], [2, refusal('PILOT_PRELOAD_REFUSED')]);
  assert.ok(existsSync(marker), 'the preload really ran in that process');
  assert.equal(existsSync(c.output.receipts), false, 'refused before the receipts file');
  assert.deepEqual((await pilot(config(), { NODE_OPTIONS: '--max-old-space-size=256' })).output, refusal('PILOT_PRELOAD_REFUSED'));
  const mock = await pilot(config(), { ATLAS_TEST_M365_PRELOAD_DIR: tmp.dir }, ['--import', './tests/support/m365-fetch-preload.ts']);
  assert.deepEqual([mock.code, mock.output], [2, refusal('PILOT_PRELOAD_REFUSED')]);
  assert.deepEqual((await pilot(config(), { ATLAS_TEST_CURSOR_SECRET: 'x'.repeat(40) })).output, refusal('PILOT_TEST_ENVIRONMENT_REFUSED'));
});

test('worker/shadow/decisions/bind and other commands are refused in a real process with exit 2 and a safe summary only', async () => {
  for (const command of ['worker-once', 'shadow-once', 'decisions-smoke', 'bind', 'm365-requeue']) {
    const c = config(command, { client: 'pilot-client' });
    const r = await pilot(c);
    assert.deepEqual([r.code, r.output], [2, refusal('PILOT_COMMAND_REFUSED')], command);
    assert.equal(existsSync(c.output.receipts), false);
  }
  const missing = await pilot(config(), { ATLAS_RUNTIME_DATABASE_URL: '' });
  assert.deepEqual([missing.code, missing.output], [2, refusal('PILOT_RUNTIME_ENVIRONMENT_MISSING')]);
});
