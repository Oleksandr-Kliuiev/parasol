import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateDirectory, safeEnvironment, redact, sqlPassword, command, pause } from './runtime.mjs';

test('state creation refuses a symlinked parent or relative path and never reuses an existing run', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'parasol-harness-guard-'));
  try {
    await mkdir(join(root, 'target')); await symlink(join(root, 'target'), join(root, 'link'));
    await assert.rejects(createStateDirectory(join(root, 'link', 'new-run')), /symlink/);
    await assert.rejects(createStateDirectory('relative/new-run'), /absolute/);
    await createStateDirectory(join(root, 'run'));
    for (const name of ['private', 'logs']) assert.equal((await stat(join(root, 'run', name))).mode & 0o777, 0o700);
    await assert.rejects(createStateDirectory(join(root, 'run')), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('child environment excludes ambient database/provider keys and diagnostic redaction removes credentials', () => {
  const ambient = { DATABASE_URL: 'synthetic', ConnectionStrings__crm: 'synthetic', Integrations__Atera__ApiKey: 'synthetic', NODE_OPTIONS: '--no-warnings' };
  const saved = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]));
  Object.assign(process.env, ambient);
  try {
    const env = safeEnvironment();
    for (const key of [...Object.keys(ambient), 'ASPNETCORE_URLS']) assert.equal(key in env, false);
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const text = redact('Bearer abcdef Server=127.0.0.1,1433;User ID=sa;Password=private;', ['abcdef']);
  assert.equal(text.includes('abcdef') || text.includes('private'), false);
});
test('SQL passwords satisfy default SQL Server policy while remaining generated and shell safe', () => {
  const first = sqlPassword(); const second = sqlPassword();
  assert.notEqual(first, second); assert.match(first, /^[A-Za-z0-9!]{32,128}$/);
  for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/, /[!]/]) assert.match(first, pattern);
});
test('bounded commands terminate only their owned descendants and handle early stdin closure', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'parasol-harness-process-'));
  const marker = join(root, 'surviving-child');
  try {
    const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>{${child}},700)`)}],{stdio:'ignore'});setTimeout(()=>{},10000);`;
    await assert.rejects(command(process.execPath, ['-e', parent], { timeout: 100 }));
    await pause(900); await assert.rejects(realpath(marker), { code: 'ENOENT' });
    await command(process.execPath, ['-e', 'process.exit(0)'], { input: 'x'.repeat(2_000_000), timeout: 2000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
