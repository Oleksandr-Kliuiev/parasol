import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { decodeSandboxFacts, processInventory, RESOLVER_SOCKET, runSandboxCheck, SANDBOX_EXEC, sandboxEnforced, serverSandboxArgv, serverSandboxPaths, serverSandboxProfile } from '../packages/reval/platform.ts';
import { ServerLink } from '../packages/reval/server-link.ts';
import { productionDeps } from '../packages/reval/deps.ts';
import type { SandboxFacts } from '../packages/reval/platform.ts';
import { buildPeer } from '../scripts/reval-server/build-peer.ts';
import { rejects } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-D-B platform layer on this host (rs-d brief B §1–§2): the PINNED Seatbelt profile S runs under really denies IP egress
// except localhost, outbound unix sockets outside the PG socket directory, the system DNS resolver socket, reads of the owner/reader
// credential files, writes to the project tree/helper/credentials/config/C's journal and exec of anything but node and the pinned helper,
// while loopback and the exact PG socket file work (a sibling socket in the same directory does not — RS-D-C N1); a descendant (the helper S spawns for its peer proofs) inherits the profile; the helper's closed
// `sandbox <pid>` mode answers for that exact pid. darwin/arm64 only. Network: 127.0.0.1, local unix sockets (the resolver socket is
// only connected to, no byte sent) and — ONLY inside the profile, where Seatbelt refuses it locally — the RFC 5737 address 192.0.2.1
// (rc2, review F4: the unsandboxed control runs never try it).
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = !darwin && 'darwin/arm64 only';
const NODE = realpathSync(process.execPath);
const PROBE = `
import net from 'node:net'; import { linkSync, readFileSync, renameSync, writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const o = JSON.parse(process.argv[2]);
const tryConnect = t => new Promise(res => { const s = net.connect({ ...t, timeout: 1500 });
  s.on('connect', () => { s.destroy(); res('CONNECTED'); }); s.on('timeout', () => { s.destroy(); res('TIMEOUT'); }); s.on('error', e => res(e.code)); });
const attempt = f => { try { f(); return 'OK'; } catch (e) { return e.code; } };
const exec = spawnSync('/bin/echo', ['x']);
const helper = spawnSync(o.helper, ['sandbox', String(process.pid)]);
const out = { external: o.external ? await tryConnect({ host: '192.0.2.1', port: 443 }) : 'NOT_TRIED', loopback: await tryConnect({ host: '127.0.0.1', port: o.port }),
  resolver: await tryConnect({ path: '/private/var/run/mDNSResponder' }), pgSocket: await tryConnect({ path: o.pgSock }), siblingSocket: await tryConnect({ path: o.siblingSock }),
  otherSocket: await tryConnect({ path: o.otherSock }), readSecret: attempt(() => readFileSync(o.secret)), writeTree: attempt(() => writeFileSync(o.writeFile, 'x')),
  writeJournal: attempt(() => writeFileSync(o.journal, 'x', { flag: 'a' })), exec: exec.error?.code ?? String(exec.status),
  renameConfigDir: attempt(() => { renameSync(o.configDir, o.configDir + '2'); renameSync(o.configDir + '2', o.configDir); }),
  renameAncestor: attempt(() => { renameSync(o.ancestor, o.ancestor + '2'); renameSync(o.ancestor + '2', o.ancestor); }),
  renameSecrets: attempt(() => { renameSync(o.secretsDir, o.secretsDir + '2'); try { readFileSync(o.secretsDir + '2/owner'); } finally { renameSync(o.secretsDir + '2', o.secretsDir); } }),
  renameHelperDir: attempt(() => { renameSync(o.helperDir, o.helperDir + '2'); renameSync(o.helperDir + '2', o.helperDir); }),
  renameRootParent: attempt(() => { renameSync(o.rootParent, o.rootParent + '2'); renameSync(o.rootParent + '2', o.rootParent); }),
  linkJournal: attempt(() => linkSync(o.journal, o.link)), bindInConfig: await new Promise(res => { const x = net.createServer().listen(o.ownSock, () => { x.close(); res('OK'); })
    .on('error', e => res(e.code)); }),
  helperSelf: helper.status === 0 ? helper.stdout.toString().trim() : 'FAILED' };
process.stdout.write(JSON.stringify(out) + '\\n');
await new Promise(r => setTimeout(r, o.delay));
`;
function run(file: string, args: string[]): { child: ReturnType<typeof spawn>; result: Promise<Record<string, string>> } {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
  let out = '';
  child.stdout!.on('data', b => { out += String(b); });
  return { child, result: new Promise(res => child.once('close', () => res(JSON.parse(out.split('\n')[0]!) as Record<string, string>))) };
}
const PATHS = { node: '/opt/homebrew/Cellar/node/25.8.1/bin/node', helper: '/h/reval-peer', pgSocket: '/pg/sock/.s.PGSQL.5432', readDenied: ['/c/secrets/owner', '/c/secrets/reader'],
  writeDenied: ['/repo', '/h/reval-peer', '/c/secrets/owner', '/c/secrets/reader', '/c/secrets/runtime', '/c/owner.json', '/c/reval-journal.jsonl'] };

test('the pinned profile text: exact rules; only node and the helper may be exec\'d; a path with quotes/whitespace/traversal is refused; realpaths', () => {
  const p = serverSandboxProfile(PATHS);
  assert.deepEqual(p.split('\n'), ['(version 1)', '(allow default)', '(deny network-outbound (remote ip))', '(allow network-outbound (remote ip "localhost:*"))',
    '(deny network-outbound (remote unix-socket))', '(allow network-outbound (remote unix-socket (path-literal "/pg/sock/.s.PGSQL.5432")))',
    `(deny network-outbound (literal "${RESOLVER_SOCKET}"))`, '(deny file-read* (literal "/c/secrets/owner") (literal "/c/secrets/reader"))',
    '(deny file-write* (subpath "/repo") (literal "/h/reval-peer") (literal "/c/secrets/owner") (literal "/c/secrets/reader") (literal "/c/secrets/runtime") (literal "/c/owner.json") (literal "/c/reval-journal.jsonl"))',
    '(deny process-exec)', '(allow process-exec (literal "/opt/homebrew/Cellar/node/25.8.1/bin/node") (literal "/h/reval-peer"))'], 'exactly the pinned rules, the resolver deny after the PG allow');
  for (const bad of ['node', '/', '/a/', '/a b/node', '/a"/node', '/a/../node', '/a/..', '/a//node', '/a/node\n(allow default)', '/a/node")(allow default']) {
    for (const over of [{ node: bad }, { helper: bad }, { pgSocket: bad }, { readDenied: [bad] }, { writeDenied: [bad] }, { writeDenied: ['/repo', bad] }]) {
      assert.throws(() => serverSandboxProfile({ ...PATHS, ...over }), /SANDBOX_PATH/, `${JSON.stringify(over)}`);
    }
  }
  assert.throws(() => serverSandboxProfile({ ...PATHS, writeDenied: [] }), /SANDBOX_PATH/); assert.throws(() => serverSandboxProfile({ ...PATHS, readDenied: [] }), /SANDBOX_PATH/);
  assert.deepEqual(serverSandboxArgv(PATHS, '/e.js', ['x']).argv.slice(2), [PATHS.node, '/e.js', 'x']);
  const dir = mkdtempSync(join(tmpdir(), 'reval-sbp-')); writeFileSync(join(dir, 'h'), ''); // tmpdir() is /var/… — the profile needs /private/var/…
  writeFileSync(join(dir, 'owner.json'), '{}');
  const real = serverSandboxPaths({ nativePeerHelper: join(dir, 'h'), endpoint: { socketDir: dir, port: 5433 }, secretFiles: { owner: join(dir, 'o'), reader: join(dir, 'r'), runtime: join(dir, 'u') } } as never,
    join(dir, 'owner.json'), NODE, dir);
  const r = realpathSync(dir);
  assert.deepEqual([real.helper, real.pgSocket, real.writeDenied[0]], [realpathSync(join(dir, 'h')), `${r}/.s.PGSQL.5433`, r], 'realpaths; the exact PG socket file');
  for (const f of [`${r}/owner.json`, `${r}/reval-journal.jsonl`, `${r}/reval-instrument.sock`, r, dirname(r), '/private']) assert.ok(real.writeDenied.includes(f), f);
  assert.ok(!real.writeDenied.includes('/'), 'the root itself is never named');
  // rc3 (review F5): every directory above EVERY named file and above the project root is named — credentials in a subdirectory, the
  // helper in its own directory, the project root's parent — except those inside the project tree (its subpath rule covers them).
  for (const d of ['cfg/secrets', 'hdir', 'proj/dist/native']) mkdirSync(join(r, d), { recursive: true });
  for (const p of ['cfg/owner.json', 'cfg/secrets/o', 'cfg/secrets/r', 'cfg/secrets/u', 'hdir/h', 'proj/dist/native/reval-peer']) writeFileSync(join(r, p), '');
  const s = join(r, 'cfg', 'secrets');
  const layout = (helper: string) => serverSandboxPaths({ nativePeerHelper: join(r, helper), endpoint: { socketDir: r, port: 5433 },
    secretFiles: { owner: join(s, 'o'), reader: join(s, 'r'), runtime: join(s, 'u') } } as never, join(r, 'cfg', 'owner.json'), NODE, join(r, 'proj')).writeDenied;
  const own = layout('hdir/h'); const inTree = layout('proj/dist/native/reval-peer');
  for (const d of [s, join(r, 'cfg'), r, dirname(r), '/private']) assert.ok(own.includes(d) && inTree.includes(d), d);
  assert.ok(own.includes(join(r, 'hdir')) && !inTree.includes(join(r, 'hdir')), 'the helper\'s own directory');
  assert.deepEqual([own[0], own.filter(p => p.startsWith(`${r}/proj/`)), new Set(own).size === own.length], [join(r, 'proj'), [], true],
    'nothing inside the tree but its subpath root; no duplicates');
  assert.ok(inTree.includes(join(r, 'proj/dist/native/reval-peer')) && !inTree.includes(join(r, 'proj/dist/native')), 'a helper in the tree: its directories via the subpath');
  assert.ok(rejects(() => decodeSandboxFacts('{"pid":1,"sandboxed":true}\n')) && rejects(() => decodeSandboxFacts('{"pid":1,"sandboxed":true,"resolverDenied":false}'))
    && rejects(() => decodeSandboxFacts('{"pid":1,"sandboxed":true,"forkDenied":true}\n')));
  assert.equal(sandboxEnforced({ pid: 5, sandboxed: true, resolverDenied: false }, 5), false);
  assert.equal(sandboxEnforced({ pid: 5, sandboxed: false, resolverDenied: true }, 5), false);
  assert.equal(sandboxEnforced({ pid: 5, sandboxed: true, resolverDenied: true }, 6), false);
  assert.equal(sandboxEnforced({ pid: 5, sandboxed: true, resolverDenied: true }, 5), true);
});

test('under the profile: external IP, other sockets, resolver, credential reads, tree writes and foreign exec EPERM; loopback and the PG socket dir allowed; the helper inherits', { skip, timeout: 60_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rsb-')));
  const script = join(dir, 'probe.mjs'); writeFileSync(script, PROBE);
  const helper = buildPeer(join(dir, 'peer')); // before any listener: a failed build must not leave one open
  for (const d of ['pg', 'p/tree', 'c/secrets', 'hx']) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ['secrets/owner', 'secrets/reader', 'secrets/runtime', 'owner.json', 'reval-journal.jsonl']) writeFileSync(join(dir, 'c', f), 'synthetic');
  // rc3 (review F5): S's helper is a copy in its own directory, so renaming that directory never races the test's own sandbox checks.
  const sHelper = join(dir, 'hx', 'reval-peer'); copyFileSync(helper.path, sHelper); chmodSync(sHelper, 0o755);
  const server = createServer(s => s.end()); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const sockets = [join(dir, 'pg', '.s.PGSQL.5432'), join(dir, 'pg', 't'), join(dir, 'o')].map(p => { const x = createServer(s => s.end()); x.listen(p); return x; });
  await Promise.all(sockets.map(x => new Promise(r => x.once('listening', r))));
  const port = (server.address() as { port: number }).port;
  const probe = (external: boolean) => JSON.stringify({ port, helper: sHelper, pgSock: join(dir, 'pg', '.s.PGSQL.5432'), siblingSock: join(dir, 'pg', 't'),
    otherSock: join(dir, 'o'), secret: join(dir, 'c', 'secrets', 'owner'), writeFile: join(dir, 'p', 'tree', 'x'), journal: join(dir, 'c', 'reval-journal.jsonl'),
    configDir: join(dir, 'c'), ancestor: dir, secretsDir: join(dir, 'c', 'secrets'), helperDir: join(dir, 'hx'), rootParent: join(dir, 'p'),
    link: join(dir, `jl${external ? 1 : 2}`), ownSock: join(dir, 'c', `h${external ? 1 : 2}`), external, delay: 1500 });
  // The PRODUCTION composition of the paths (rc2 F4): the owner config at c/owner.json with the credentials in c/secrets/ (the test-harness
  // layout), the helper in its own directory hx/, the project tree at p/tree/ (rc3 F5: its parent p/ is above nothing else).
  const paths = serverSandboxPaths({ nativePeerHelper: sHelper, endpoint: { socketDir: join(dir, 'pg'), port: 5432 },
    secretFiles: { owner: join(dir, 'c', 'secrets', 'owner'), reader: join(dir, 'c', 'secrets', 'reader'), runtime: join(dir, 'c', 'secrets', 'runtime') } } as never,
    join(dir, 'c', 'owner.json'), NODE, join(dir, 'p', 'tree'));
  try {
    const { file, argv } = serverSandboxArgv(paths, script, [probe(true)]);
    const boxed = run(file, argv);
    await new Promise(r => setTimeout(r, 700));
    const facts = await runSandboxCheck(helper.path, boxed.child.pid!);
    assert.deepEqual(facts, { pid: boxed.child.pid, sandboxed: true, resolverDenied: true });
    assert.equal(sandboxEnforced(facts, boxed.child.pid!), true);
    const r1 = await boxed.result;
    assert.deepEqual({ ...r1, helperSelf: undefined }, { external: 'EPERM', loopback: 'CONNECTED', resolver: 'EPERM', pgSocket: 'CONNECTED', siblingSocket: 'EPERM',
      otherSocket: 'EPERM', readSecret: 'EPERM', writeTree: 'EPERM', writeJournal: 'EPERM', exec: 'EPERM', renameConfigDir: 'EPERM', renameAncestor: 'EPERM',
      renameSecrets: 'EPERM', renameHelperDir: 'EPERM', renameRootParent: 'EPERM', linkJournal: 'EPERM', bindInConfig: 'OK', helperSelf: undefined });
    assert.equal(JSON.parse(r1.helperSelf!).sandboxed, true, 'the helper S spawns runs, and its own answer for S agrees');
    assert.equal(JSON.parse(r1.helperSelf!).resolverDenied, true);
    const plain = run(NODE, [script, probe(false)]);
    await new Promise(r => setTimeout(r, 700));
    assert.deepEqual(await runSandboxCheck(helper.path, plain.child.pid!), { pid: plain.child.pid, sandboxed: false, resolverDenied: false });
    const r2 = await plain.result;
    assert.deepEqual([r2.external, r2.exec, r2.resolver, r2.siblingSocket, r2.otherSocket, r2.readSecret, r2.writeTree, r2.writeJournal, r2.renameConfigDir,
      r2.renameAncestor, r2.renameSecrets, r2.renameHelperDir, r2.renameRootParent, r2.linkJournal],
    ['NOT_TRIED', '0', 'CONNECTED', 'CONNECTED', 'CONNECTED', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK'],
      'without the profile the same probe can exec, reach the sockets, read and write (and never tries an external address)');
    const foreign = run(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)\n(deny network-outbound (remote ip))', NODE, script, probe(false)]);
    await new Promise(r => setTimeout(r, 700));
    const ff = await runSandboxCheck(helper.path, foreign.child.pid!);
    assert.deepEqual(ff, { pid: foreign.child.pid, sandboxed: true, resolverDenied: false }, 'another profile is sandboxed but not the pinned one');
    assert.equal(sandboxEnforced(ff, foreign.child.pid!), false);
    await foreign.result;
    // A profile that denies other unix sockets but allows the resolver is not the pinned one either: the helper checks THAT socket.
    const near = run(SANDBOX_EXEC, ['-p', `(version 1)\n(allow default)\n(deny network-outbound (remote unix-socket))\n(allow network-outbound (literal "${RESOLVER_SOCKET}"))`,
      NODE, script, probe(false)]);
    await new Promise(r => setTimeout(r, 700));
    assert.deepEqual(await runSandboxCheck(helper.path, near.child.pid!), { pid: near.child.pid, sandboxed: true, resolverDenied: false });
    await near.result;
    await assert.rejects(runSandboxCheck(helper.path, 2 ** 31 - 2), /SANDBOX_CHECK/, 'a pid with no process is a failure, never "not sandboxed"');
  } finally { server.close(); for (const x of sockets) x.close(); }
});

test('ServerLink.enforcedNow: READY, the verified pid is still its live child, and the helper answers sandboxed + resolver denied NOW', async () => {
  let answer: SandboxFacts | Error = { pid: 42, sandboxed: true, resolverDenied: true }; const asked: number[] = [];
  const deps: Record<string, unknown> = { spawnServer: () => { throw new Error('no S here'); },
    sandboxCheck: async (_h: string, pid: number) => { asked.push(pid); if (answer instanceof Error) throw answer; return answer; } };
  const link = new ServerLink(deps as never, { registrationId: randomUUID(), nativePeerHelper: '/h' } as never, randomUUID(), () => null, '/c/owner.json');
  assert.equal(await link.ready, false);
  const set = link as unknown as { state: string; facts: { pid: number } | null; child: { pid: number; exitCode: number | null; signalCode: null; kill(): void } | null };
  const live = () => { set.state = 'READY'; set.facts = { pid: 42 }; set.child = { pid: 42, exitCode: null, signalCode: null, kill: () => undefined }; };
  live(); assert.equal(await link.enforcedNow(), true); assert.deepEqual(asked, [42]);
  answer = { pid: 42, sandboxed: true, resolverDenied: false }; assert.equal(await link.enforcedNow(), false, 'another profile');
  answer = { pid: 42, sandboxed: false, resolverDenied: false }; assert.equal(await link.enforcedNow(), false, 'not sandboxed');
  answer = { pid: 43, sandboxed: true, resolverDenied: true }; assert.equal(await link.enforcedNow(), false, 'an answer for another pid');
  answer = new Error('SANDBOX_CHECK'); assert.equal(await link.enforcedNow(), false, 'a failed check');
  answer = { pid: 42, sandboxed: true, resolverDenied: true };
  set.child!.exitCode = 0; assert.equal(await link.enforcedNow(), false, 'S exited');
  live(); set.child!.pid = 77; assert.equal(await link.enforcedNow(), false, 'the child is not the verified incarnation');
  live(); set.state = 'LOST'; asked.length = 0; assert.equal(await link.enforcedNow(), false, 'not READY'); assert.deepEqual(asked, [], 'not even asked');
  live(); answer = { pid: 42, sandboxed: true, resolverDenied: true };
  deps.sandboxCheck = async (_h: string, pid: number) => { set.state = 'LOST'; return { pid, sandboxed: true, resolverDenied: true }; };
  assert.equal(await link.enforcedNow(), false, 'S lost while the helper answered (rc2 N7)');
});

test('processInventory (DRAIN): COMPLETE only with S enforced now AND only S/C backends; every failure or stall is INCOMPLETE (rc2 N7)', { timeout: 20_000 }, async () => {
  const roles = { runtime: 'rt', reader: 'rd' };
  const never = new Promise<never>(() => undefined);
  const reader = (n: number | 'THROW' | 'STALL') => ({ query: async () => n === 'THROW' ? Promise.reject(new Error('read')) : n === 'STALL' ? never : { rows: [{ n }] } }) as never;
  const inv = (server: unknown, rd: () => Promise<unknown>) => processInventory({ server: server as never, reader: rd as never, roles, deadline: performance.now() + 300 });
  const on = { enforcedNow: async () => true };
  assert.equal(await inv(on, async () => reader(0)), 'COMPLETE');
  for (const [server, rd, why] of [[null, async () => reader(0), 'no S'], [{ enforcedNow: async () => false }, async () => reader(0), 'S not enforced'],
    [{ enforcedNow: async () => { throw new Error('x'); } }, async () => reader(0), 'enforcement check failed'], [{ enforcedNow: () => never }, async () => reader(0), 'enforcement check stalls'],
    [on, async () => null, 'no reader'], [on, async () => { throw new Error('x'); }, 'reader failed'], [on, () => never, 'reader stalls'],
    [on, async () => reader(1), 'a foreign backend'], [on, async () => reader('THROW'), 'inventory read failed'], [on, async () => reader('STALL'), 'inventory read stalls']] as const) {
    const t0 = performance.now();
    assert.equal(await inv(server, rd), 'INCOMPLETE', why);
    assert.ok(performance.now() - t0 < 1000, `${why}: bounded`);
  }
});

test('production wiring (rc2 F4): productionDeps().spawnServer puts the PINNED profile of THIS config path on the sandbox-exec argv', { skip, timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rsw-')));
  mkdirSync(join(dir, 'cfg')); const configPath = join(dir, 'cfg', 'owner.json'); writeFileSync(configPath, '{}');
  const entry = join(dir, 'idle.mjs'); writeFileSync(entry, 'setTimeout(() => {}, 5000);\n');
  const config = { server: { apiEntry: entry, port: 39999 }, nativePeerHelper: join(dir, 'h'), endpoint: { socketDir: join(dir, 'pg'), port: 5432 },
    secretFiles: { owner: join(dir, 'cfg', 'o'), reader: join(dir, 'cfg', 'r'), runtime: join(dir, 'cfg', 'u') } };
  const child = productionDeps().spawnServer(config as never, configPath);
  try {
    const [file, flag, profile, node, script] = child.spawnargs;
    assert.deepEqual([file, flag, node, script], [SANDBOX_EXEC, '-p', NODE, entry]);
    for (const p of [configPath, join(dir, 'cfg', 'reval-journal.jsonl'), join(dir, 'cfg', 'reval-instrument.sock'), join(dir, 'cfg'), dir]) {
      assert.ok(profile!.includes(`(literal "${p}")`), p);
    }
    assert.ok(profile!.includes(`(remote unix-socket (path-literal "${join(dir, 'pg')}/.s.PGSQL.5432"))`));
  } finally { child.kill('SIGKILL'); }
});
