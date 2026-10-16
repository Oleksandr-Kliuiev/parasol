import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasError } from '../packages/core/contracts.ts';
import { canonicalJson } from '../packages/events/identity.ts';
import { canonicalHash, deriveRequestId, intentHash, markedTitle, normalizeInput, parsePreviewDocument } from '../packages/actions/canonical.ts';
import { actionComposition } from '../packages/actions/policy.ts';
import { readProtectedJson, writeProtectedFile } from '../packages/actions/private-file.ts';

// Stage 3 S3-A, A2 and C7 (protected files) without a database: raw-scalar validation before NFC/trim, scalar limits,
// deterministic UUIDv8 request IDs, intent/canonical hashes, DISABLED-by-default composition, protected files.
const KEY = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
const base = { connectionId: 'atera-a', title: 'Printer offline', description: 'Line one\nLine two', idempotencyKey: KEY };
const code = (expected: string) => (e: unknown) => e instanceof AtlasError && e.code === expected && !String(e.message).includes('CANARY');

test('input: raw scalars are validated before NFC/trim; refused categories, lone surrogates and limits give one fixed code', () => {
  const ok = normalizeInput({ ...base, title: '  Café ✓  ', description: '\n Body \n' });
  assert.equal(ok.title, 'Café ✓', 'NFC composed, trimmed');
  assert.equal(ok.description, 'Body');
  assert.equal(normalizeInput({ ...base, title: '😀'.repeat(160) }).title.length, 320, '160 scalar values (astral) fit although 320 code units');
  assert.ok(normalizeInput({ ...base, description: 'x'.repeat(2000) }));
  const refused: [string, Partial<typeof base>][] = [
    ['lone high surrogate', { title: 'CANARY a\ud800b' }], ['lone low surrogate', { description: 'CANARY \udc00' }],
    ['C0 control', { title: 'CANARY\u0007' }], ['CR in description', { description: 'CANARY\r\nx' }], ['tab', { title: 'CANARY\tx' }],
    ['LF in title', { title: 'CANARY\nx' }], ['C1 control', { description: 'CANARY\u0085' }], ['bidi override (Cf)', { title: 'CANARY‮' }],
    ['zero-width space (Cf)', { title: 'CANARY​' }], ['BOM (Cf)', { title: '﻿CANARY' }], ['private use (Co)', { title: 'CANARY' }],
    ['noncharacter', { title: 'CANARY﷐' }], ['noncharacter FFFF', { description: 'CANARY￿' }], ['astral noncharacter', { title: 'CANARY\u{10ffff}' }],
    ['unassigned (Cn)', { title: 'CANARY͸' }], ['empty after trim', { title: '   ' }], ['title over 160', { title: 'CANARY' + 'x'.repeat(155) }],
    ['description over 2000', { description: 'CANARY' + 'x'.repeat(1995) }], ['not a UUID', { idempotencyKey: 'CANARY' }],
    ['upper-case UUID', { idempotencyKey: KEY.toUpperCase() }], ['bad connection id', { connectionId: 'CANARY id' }],
  ];
  for (const [label, change] of refused) assert.throws(() => normalizeInput({ ...base, ...change }), code('ACTION_INPUT_INVALID'), label);
  for (const shape of [{ ...base, extra: 'CANARY' }, { connectionId: 'atera-a', title: 't', description: 'd' }, [base], null, 'CANARY', { ...base, title: 7 }]) {
    assert.throws(() => normalizeInput(shape), code('ACTION_INPUT_INVALID'), JSON.stringify(shape));
  }
});

test('request ID: UUIDv8 from the first 16 bytes of SHA-256 over the canonical scope tuple, 122 hash bits kept; marker and marked title', () => {
  const id = deriveRequestId('w', 'c', 'actor', KEY);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'version 8, RFC variant');
  assert.equal(deriveRequestId('w', 'c', 'actor', KEY), id, 'deterministic');
  const digest = createHash('sha256').update(canonicalJson({ dto: 'action-id/1', workspaceId: 'w', clientId: 'c', requesterActorId: 'actor', idempotencyKey: KEY })).digest();
  const bytes = Buffer.from(id.replace(/-/g, ''), 'hex');
  for (let i = 0; i < 16; i++) {
    const mask = i === 6 ? 0x0f : i === 8 ? 0x3f : 0xff; // only the 4 version and 2 variant bits are replaced
    assert.equal(bytes[i]! & mask, digest[i]! & mask, `byte ${i}`);
  }
  const variants = [deriveRequestId('w2', 'c', 'actor', KEY), deriveRequestId('w', 'c2', 'actor', KEY), deriveRequestId('w', 'c', 'other', KEY),
    deriveRequestId('w', 'c', 'actor', '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ac')];
  assert.equal(new Set([id, ...variants]).size, 5, 'every component of the tuple changes the ID');
  const marked = markedTitle('t'.repeat(160), id);
  assert.equal(marked, `${'t'.repeat(160)} [Atlas:${id}]`);
  assert.ok([...marked].length <= 240);
});

test('hashes: canonical (key-order independent); intent covers connection, title and description, not the idempotency key', () => {
  assert.equal(canonicalHash({ a: 1, b: 'x' }), canonicalHash({ b: 'x', a: 1 }));
  const a = normalizeInput(base);
  assert.equal(intentHash(a), intentHash({ ...a, idempotencyKey: '00000000-0000-4000-8000-000000000000' }));
  assert.notEqual(intentHash(a), intentHash({ ...a, title: 'Printer offline!' }));
  assert.notEqual(intentHash(a), intentHash({ ...a, connectionId: 'atera-b' }));
  assert.notEqual(intentHash(a), intentHash({ ...a, description: 'Line one\nLine two ' + 'x' }));
});

test('composition: DISABLED by default; only exact MOCK; LIVE, custom origins/ports/scripts/callbacks refused', () => {
  assert.throws(() => actionComposition({}), code('ACTION_MODE_DISABLED'));
  assert.throws(() => actionComposition({ ATLAS_ACTIONS_MODE: 'DISABLED' }), code('ACTION_MODE_DISABLED'));
  for (const mode of ['LIVE', 'mock', 'MOCK ', 'PRODUCTION']) assert.throws(() => actionComposition({ ATLAS_ACTIONS_MODE: mode }), code('ACTION_MODE_REFUSED'), mode);
  for (const v of ['ATLAS_ACTIONS_ORIGIN', 'ATLAS_ACTIONS_PORT', 'ATLAS_ACTIONS_SCRIPT', 'ATLAS_ACTIONS_CALLBACK', 'ATLAS_ACTIONS_LIVE']) {
    assert.throws(() => actionComposition({ ATLAS_ACTIONS_MODE: 'MOCK', [v]: 'https://example.invalid' }), code('ACTION_MODE_REFUSED'), v);
  }
  assert.deepEqual(actionComposition({ ATLAS_ACTIONS_MODE: 'MOCK' }).mode, 'MOCK');
});

test('preview document parser accepts exactly the whitelist', () => {
  const doc = { kind: 'STORED_ACTION_PREVIEW', dto: 'atlas-action-preview/1', requestId: 'r', workspaceId: 'w', clientId: 'c', connectionId: 'a',
    actionType: 't', actionVersion: 'v', policyVersion: 'p', portVersion: 'q', mode: 'MOCK', title: 'x', description: 'y', marker: 'm', inputHash: 'h' };
  assert.deepEqual(parsePreviewDocument(doc), doc);
  assert.throws(() => parsePreviewDocument({ ...doc, customerKey: 'CANARY' }), code('APPROVAL_PREVIEW_MISMATCH'));
  const { inputHash: _omitted, ...missing } = doc;
  assert.throws(() => parsePreviewDocument(missing), code('APPROVAL_PREVIEW_MISMATCH'));
  assert.throws(() => parsePreviewDocument({ ...doc, title: 1 }), code('APPROVAL_PREVIEW_MISMATCH'));
});

test('protected output: absolute NEW path outside any Git checkout, O_EXCL/O_NOFOLLOW, 0600 even under a restrictive umask', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-private-'));
  try {
    const target = join(dir, 'preview.json');
    const previous = process.umask(0o777);
    try { await writeProtectedFile(target, 'CANARY content'); } finally { process.umask(previous); }
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(await readFile(target, 'utf8'), 'CANARY content');
    await assert.rejects(writeProtectedFile(target, 'again'), code('ACTION_OUTPUT_INVALID'), 'an existing file is never overwritten');
    await symlink(join(dir, 'elsewhere.json'), join(dir, 'link.json'));
    await assert.rejects(writeProtectedFile(join(dir, 'link.json'), 'x'), code('ACTION_OUTPUT_INVALID'), 'a dangling symlink is not followed');
    await assert.rejects(stat(join(dir, 'elsewhere.json')), /ENOENT/);
    await assert.rejects(writeProtectedFile('relative/preview.json', 'x'), code('ACTION_OUTPUT_INVALID'));
    await assert.rejects(writeProtectedFile(join(dir, 'missing-dir', 'p.json'), 'x'), code('ACTION_OUTPUT_INVALID'));
    const repo = fileURLToPath(new URL('../', import.meta.url));
    await assert.rejects(writeProtectedFile(join(repo, 'verification', 'never-written.json'), 'x'), code('ACTION_OUTPUT_INVALID'), 'inside this checkout');
    await assert.rejects(stat(join(repo, 'verification', 'never-written.json')), /ENOENT/);
    await mkdir(join(dir, 'worktree', '.git'), { recursive: true }); await mkdir(join(dir, 'worktree', 'deep', 'er'), { recursive: true });
    await assert.rejects(writeProtectedFile(join(dir, 'worktree', 'deep', 'er', 'p.json'), 'x'), code('ACTION_OUTPUT_INVALID'), 'an ancestor holds a .git marker');
    await mkdir(join(dir, 'linked'), { recursive: true }); await writeFile(join(dir, 'linked', '.git'), 'gitdir: /elsewhere');
    await assert.rejects(writeProtectedFile(join(dir, 'linked', 'p.json'), 'x'), code('ACTION_OUTPUT_INVALID'), 'a worktree .git file marker');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('protected input: one descriptor, exact 0600, own, single link, bounded, strict UTF-8 JSON; errors never echo content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-private-'));
  try {
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify({ v: 'CANARY' }), { mode: 0o600 });
    assert.deepEqual(await readProtectedJson(good, 1024), { v: 'CANARY' });
    const wide = join(dir, 'wide.json'); await writeFile(wide, '{}', { mode: 0o644 });
    await assert.rejects(readProtectedJson(wide, 1024), code('ACTION_INPUT_INVALID'), 'mode other than 0600');
    await symlink(good, join(dir, 'sym.json'));
    await assert.rejects(readProtectedJson(join(dir, 'sym.json'), 1024), code('ACTION_INPUT_INVALID'), 'symlink not followed');
    await link(good, join(dir, 'hard.json'));
    await assert.rejects(readProtectedJson(good, 1024), code('ACTION_INPUT_INVALID'), 'a second hard link');
    await rm(join(dir, 'hard.json'));
    await assert.rejects(readProtectedJson(good, 5), code('ACTION_INPUT_INVALID'), 'over the size bound');
    await assert.rejects(readProtectedJson(dir, 1024), code('ACTION_INPUT_INVALID'), 'a directory');
    const badUtf8 = join(dir, 'bad.json'); await writeFile(badUtf8, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), { mode: 0o600 });
    await assert.rejects(readProtectedJson(badUtf8, 1024), code('ACTION_INPUT_INVALID'), 'invalid UTF-8');
    const badJson = join(dir, 'badjson.json'); await writeFile(badJson, '{"CANARY": ', { mode: 0o600 });
    await assert.rejects(readProtectedJson(badJson, 1024), code('ACTION_INPUT_INVALID'), 'invalid JSON');
    await assert.rejects(readProtectedJson('relative.json', 1024), code('ACTION_INPUT_INVALID'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('protected input: a 0600 FIFO without a writer is refused at once (non-blocking open, same-descriptor fstat), never waited on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-private-'));
  try {
    const fifo = join(dir, 'input.json');
    const made = spawnSync('mkfifo', ['-m', '600', fifo]);
    assert.equal(made.status, 0, 'mkfifo');
    assert.ok((await stat(fifo)).isFIFO() && ((await stat(fifo)).mode & 0o777) === 0o600);
    // Bounded subprocess: a regression (blocking open) is killed by the timeout instead of hanging this test run.
    const reader = new URL('../packages/actions/private-file.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import { readProtectedJson } from ${JSON.stringify(reader)};
       try { await readProtectedJson(process.env.ATLAS_TEST_FIFO, 16384); console.log('READ'); } catch (e) { console.log(e?.code ?? 'UNKNOWN'); }`],
      { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '', ATLAS_TEST_FIFO: fifo } });
    assert.equal(child.error, undefined, 'the reader returned within the bound (no timeout kill)');
    assert.equal(child.signal, null);
    assert.deepEqual([child.status, child.stdout.trim()], [0, 'ACTION_INPUT_INVALID']);
    const good = join(dir, 'good.json');
    await writeFile(good, '{"still":"readable"}', { mode: 0o600 });
    assert.deepEqual(await readProtectedJson(good, 1024), { still: 'readable' }, 'regular 0600 files still read');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
