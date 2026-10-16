import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const atlas = 'apps/atlas';
const crm = 'apps/crm';
const web = `${crm}/web`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dotnet = process.env.DOTNET ?? 'dotnet';
const command = (cwd, exe, ...args) => ({ cwd, exe, args });
const nr = (cwd, name, ...args) => command(cwd, npm, 'run', name, ...args);
const test = name => command(crm, dotnet, 'test', '--project', `tests/Crm.${name}Tests/Crm.${name}Tests.csproj`, '--no-build', '-c', 'Release');
const tasks = {
  bootstrap: [command(atlas, npm, 'ci'), command(web, npm, 'ci'), command(crm, dotnet, 'restore', 'Vardahei.Crm.slnx')],
  'build:atlas': [nr(atlas, 'db:generate'), nr(atlas, 'api:build'), command(atlas, process.execPath, '--experimental-strip-types', 'scripts/operator-measured-build.ts')],
  'build:crm': [command(crm, dotnet, 'build', 'Vardahei.Crm.slnx', '--no-restore', '-c', 'Release'), nr(web, 'build')],
  build: ['build:atlas', 'build:crm'],
  'check:atlas': [nr(atlas, 'typecheck'), nr(atlas, 'ui:typecheck'), nr(atlas, 'schema:validate')],
  'check:crm': [nr(web, 'lint'), nr(web, 'typecheck'), nr(web, 'test', '--', '--maxWorkers=2'), 'test:crm:unit', 'test:crm:architecture'],
  check: [command('.', process.execPath, 'scripts/verify-history.mjs'), 'check:atlas', 'check:crm', command('.', process.execPath, 'scripts/atlas-tests.mjs')],
  'test:atlas:strict': [command('.', process.execPath, 'scripts/atlas-tests.mjs')],
  'test:atlas:pg': [command('.', process.execPath, 'scripts/atlas-tests.mjs', 'pg')],
  'test:atlas:ui': [nr(atlas, 'api:build'), command('.', process.execPath, 'scripts/atlas-browser-tests.mjs')],
  'test:crm:unit': [test('Unit')],
  'test:crm:architecture': [test('Architecture')],
  'test:crm:integration': [test('Integration')],
  'test:crm:e2e': [nr(web, 'e2e')],
};
function run(name) {
  if (!tasks[name]) throw new Error(`Unknown task: ${name}`);
  for (const step of tasks[name]) {
    if (typeof step === 'string') { run(step); continue; }
    console.log(`\n[${step.cwd}] ${step.exe} ${step.args.join(' ')}`);
    const result = spawnSync(step.exe, step.args, { cwd: `${root}${step.cwd}`, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 (see .nvmrc).');
run(process.argv[2]);
