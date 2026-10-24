import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateDirectory, secret, sqlPassword, freePort, jsonFile, command, startProcess, waitReady, pause, safeEnvironment } from '../../../../tools/composition/runtime.mjs';
import { certificates, writeAppConfig, appEnvironment, connectionString } from '../../../../tools/composition/config.mjs';
import { docker, sql, prepareSqlLogins, removeOwnedContainer } from '../../../../tools/composition/database.mjs';
import { SQL_IMAGE } from '../../../../tools/composition/plan.mjs';
import { requireBrowserPass } from '../../../../scripts/test-result.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const directory = process.argv[2];
await createStateDirectory(directory);
const runId = randomBytes(6).toString('hex');
const state = { root, directory, runId, sqlContainer: `parasol-composition-${runId}-sql`, pgContainer: `parasol-composition-${runId}-pg`,
  sqlDatabase: `crm_e2e_readiness_${runId}`, sqlSaPassword: sqlPassword(), sqlWebPassword: sqlPassword(), sqlWorkerPassword: sqlPassword(), documentVolumeId: randomUUID(), ports: {} };
for (const kind of ['sql', 'web', 'worker']) state.ports[kind] = await freePort();
if (new Set(Object.values(state.ports)).size !== 3) throw new Error('Distinct fixture ports are required.');
state.baseUrl = `https://localhost:${state.ports.web}`; state.atlasBridgeUrl = 'http://127.0.0.1:1/disabled/';
async function sourceHashes() {
  const names = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/crm/src', 'apps/crm/web', 'apps/crm/tools/testing'],
    { cwd: root, label: 'Finance verification inputs' })).split('\0').filter(Boolean).sort();
  const result = {};
  for (const name of names) result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  return result;
}
const before = await sourceHashes(); await jsonFile(join(directory, 'inputs-before.json'), before);
const processes = []; let browser; let stage = 'build'; let cleanup = false; let passed = false;
const controller = new AbortController();
const abort = () => controller.abort(new Error('Owned mock-browser run interrupted.'));
process.once('SIGINT', abort); process.once('SIGTERM', abort);
const allSecrets = [state.sqlSaPassword, state.sqlWebPassword, state.sqlWorkerPassword];
try {
  const env = safeEnvironment();
  for (const [label, path, args] of [
    ['types', 'node_modules/typescript/bin/tsc', ['-b']], ['spa', 'node_modules/vite/bin/vite.js', ['build']],
    ['budget', 'scripts/bundle-budget.mjs', []],
  ]) await command(process.execPath, [join(root, 'apps/crm/web', path), ...args], {
    cwd: join(root, 'apps/crm/web'), env, label, logPath: join(directory, `logs/${label}.log`), signal: controller.signal });
  for (const host of ['Crm.Web', 'Crm.Worker']) await command('dotnet', ['build', `src/Hosts/${host}/${host}.csproj`, '--no-restore', '-c', 'Release', '-m:1', '-p:UseSharedCompilation=false'], {
    cwd: join(root, 'apps/crm'), env, label: host + ' build', logPath: join(directory, `logs/${host}-build.log`), signal: controller.signal });
  stage = 'certificate';
  await certificates(state); allSecrets.push(state.certificatePassword);
  state.certificatePublic = await readFile(state.certificatePublicPath, 'utf8');
  stage = 'owned SQL'; await docker(['image', 'inspect', SQL_IMAGE]);
  const secretPath = join(directory, 'private/sql-password');
  await writeFile(secretPath, state.sqlSaPassword, { mode: 0o600 }); await chmod(secretPath, 0o444);
  await docker(['run', '--detach', '--pull=never', '--platform', 'linux/amd64', '--name', state.sqlContainer,
    '--label', `parasol.composition.run=${runId}`, '--publish', `127.0.0.1:${state.ports.sql}:1433`,
    '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_PID=Express', '--env', 'MSSQL_MEMORY_LIMIT_MB=2048',
    '--mount', `type=bind,src=${secretPath},dst=/run/secrets/sql-sa-password,readonly`,
    '--mount', `type=bind,src=${join(root, 'deploy/hostinger/sql-entrypoint.sh')},dst=/opt/parasol/sql-entrypoint.sh,readonly`,
    '--entrypoint', '/bin/sh', SQL_IMAGE, '/opt/parasol/sql-entrypoint.sh']);
  const deadline = Date.now() + 180_000; let ready = false;
  while (!ready && Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try { await sql(state, 'SELECT 1;', 'master'); ready = true; } catch { await pause(500); }
  }
  if (!ready) throw new Error('Owned SQL readiness failed.');
  stage = 'migrations';
  const migrate = await writeAppConfig(state, 'migrate');
  await command('dotnet', [join(root, 'apps/crm/src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll'), '--migrate-only'],
    { cwd: join(root, 'apps/crm/src/Hosts/Crm.Web'), env: appEnvironment(migrate, state.baseUrl), label: 'Owned CRM migrations',
      logPath: join(directory, 'logs/migrate.log'), secrets: allSecrets, signal: controller.signal });
  await prepareSqlLogins(state);
  stage = 'compiled CRM hosts';
  for (const [kind, host, url] of [['web', 'Crm.Web', state.baseUrl], ['worker', 'Crm.Worker', `https://localhost:${state.ports.worker}`]]) {
    const config = await writeAppConfig(state, kind);
    const handle = startProcess('dotnet', [join(root, `apps/crm/src/Hosts/${host}/bin/Release/net10.0/${host}.dll`),
      // This owned 67-case fixture shares durable development users across all engines.
      // Match the existing E2E-only budget; production and composition limits stay unchanged.
      ...(kind === 'web' ? ['--RateLimits:ApiPerMinute=100000'] : [])], {
      cwd: join(root, `apps/crm/src/Hosts/${host}`), env: appEnvironment(config, url), label: host });
    processes.push(handle);
    void handle.exited.then(() => { if (!handle.stopping) controller.abort(new Error('Owned CRM host exited.')); });
    await waitReady(`${url}/health/ready`, handle, 200, 120_000, { ca: state.certificatePublic });
  }
  await jsonFile(join(directory, 'private/finance-state.json'), state);
  stage = 'browser assertions';
  const configPath = join(directory, 'private/playwright.config.ts');
  const config = `import { defineConfig } from ${JSON.stringify(join(root, 'apps/crm/web/node_modules/@playwright/test/index.mjs'))};
import base from ${JSON.stringify(join(root, 'apps/crm/web/playwright.config.ts'))};
export default defineConfig({ ...base, testDir: ${JSON.stringify(join(root, 'apps/crm/web/e2e-finance'))}, webServer: [], workers: 1, retries: 0, projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  outputDir: ${JSON.stringify(join(directory, 'browser-artifacts/test-results'))}, reporter: [['list'], ['json', {outputFile: ${JSON.stringify(join(directory, 'browser-artifacts/report.json'))}}]],
  use: {...base.use, baseURL: ${JSON.stringify(state.baseUrl)}, trace: 'off'} });
`;
  await writeFile(configPath, config, { mode: 0o600 });
  await command(process.execPath, [join(root, 'apps/crm/web/node_modules/@playwright/test/cli.js'), 'test', '-c', configPath,
] , {
    cwd: join(root, 'apps/crm/web'), env: safeEnvironment({ E2E_SQL: connectionString(state, 'composition_web', state.sqlWebPassword), PARASOL_FINANCE_STATE: join(directory, 'private/finance-state.json'), UI_LAYOUT_AUDIT_MODULE: process.env.UI_LAYOUT_AUDIT_MODULE ?? '' }),
    label: 'Customer finance real API, role and layout browser checks', timeout: 600_000, logPath: join(directory, 'logs/browser.log'), secrets: allSecrets, signal: controller.signal,
  });
  browser = requireBrowserPass(JSON.parse(await readFile(join(directory, 'browser-artifacts/report.json'), 'utf8')), 0);
  if (browser.expected !== 5) throw new Error('All five customer-finance browser cases are required.');
  stage = 'source verification';
  const after = await sourceHashes();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Finance verification inputs changed.');
  await jsonFile(join(directory, 'inputs-after.json'), after);
  passed = true;
} catch { /* Fixed stage only; private logs are redacted. */ }
finally {
  const errors = [];
  for (const handle of processes.reverse()) try { await handle.stop(); } catch { errors.push(handle.label); }
  try { await removeOwnedContainer(state, state.sqlContainer); } catch { errors.push('owned SQL'); }
  cleanup = errors.length === 0;
  if (cleanup) await rm(join(directory, 'private'), { recursive: true, force: true });
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
await jsonFile(join(directory, 'report.json'), { kind: 'crm-customer-finance-real-api-and-layout', passed: passed && cleanup, stage: passed ? 'complete' : stage, browser, cleanup, inputFiles: Object.keys(before).length, inputsUnchanged: passed });
console.log(JSON.stringify({ passed: passed && cleanup, stage: passed ? 'complete' : stage, browser, cleanup }));
if (!passed || !cleanup) process.exitCode = 1;
