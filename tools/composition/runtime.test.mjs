import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateDirectory, stateFile, safeEnvironment, redact, sqlPassword, command, pause } from './runtime.mjs';

test('state creation refuses a symlinked parent and private state refuses a symlink or public mode', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'parasol-composition-guard-'));
  try {
    await mkdir(join(root, 'target')); await symlink(join(root, 'target'), join(root, 'link'));
    await assert.rejects(createStateDirectory(join(root, 'link', 'new-run')), /symlink/);
    await writeFile(join(root, 'state.json'), '{}', { mode: 0o600 });
    await symlink(join(root, 'state.json'), join(root, 'state-link.json'));
    await assert.rejects(stateFile(join(root, 'state-link.json')));
    await writeFile(join(root, 'public.json'), '{}', { mode: 0o644 }); await assert.rejects(stateFile(join(root, 'public.json')));
    assert.deepEqual(await stateFile(join(root, 'state.json')), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('child environment excludes ambient database/provider keys and diagnostic redaction removes credentials', () => {
  const env = safeEnvironment();
  assert.equal('DATABASE_URL' in env, false); assert.equal('ASPNETCORE_URLS' in env, false);
  assert.equal('ATLAS_DEMO_TOKEN' in env, false); assert.equal('NODE_OPTIONS' in env, false);
  assert.equal(redact('Bearer abcdef postgres://user:pass@localhost/db Password=private;', ['abcdef']).includes('private'), false);
});
test('SQL passwords satisfy default SQL Server policy while remaining generated and shell safe', () => {
  const first = sqlPassword(); const second = sqlPassword();
  assert.notEqual(first, second); assert.match(first, /^[A-Za-z0-9!]{32,128}$/);
  for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/, /[!]/]) assert.match(first, pattern);
});
test('bounded commands terminate only their owned descendants and handle early stdin closure', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'parasol-composition-process-'));
  const marker = join(root, 'surviving-child');
  try {
    const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>{${child}},700)`)}],{stdio:'ignore'});setTimeout(()=>{},10000);`;
    await assert.rejects(command(process.execPath, ['-e', parent], { timeout: 100 }));
    await pause(900); await assert.rejects(realpath(marker), { code: 'ENOENT' });
    await command(process.execPath, ['-e', 'process.exit(0)'], { input: 'x'.repeat(2_000_000), timeout: 2000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
