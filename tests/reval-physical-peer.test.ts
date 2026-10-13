import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROLLER_EXIT } from '../packages/reval/codes.ts';
import { createController, productionDeps } from '../packages/reval/controller.ts';
import type { ControllerDeps } from '../packages/reval/deps.ts';
import { childPeerOk, PeerError, runPeerHelper, sameIncarnation, verifyHelperBinary } from '../packages/reval/peer.ts';
import type { PeerFacts } from '../packages/reval/peer.ts';
import { nodePhysicalDeps, PhysicalAuthError, PhysicalMismatchError, recheckPhysical, verifyPhysicalEndpoint } from '../packages/reval/physical.ts';
import { DeadlineExceeded } from '../packages/reval/deadline.ts';
import { E_CONNECT_TIMEOUT_MS, productionExecConnect, runOwnerExec } from '../packages/reval/owner-exec.ts';
import type { ConnectOptions, QueryClient } from '../packages/reval/physical.ts';
import { buildPeer } from '../scripts/reval-server/build-peer.ts';

// R-EVAL RS-A physical comparator (brief §3, no PostgreSQL needed: a real AF_UNIX socket and a synthetic postmaster.pid),
// actual Darwin peer proofs with a freshly built helper, and the controller's fail-closed gate before ANY DB/spawn effect.
const root = await realpath(await mkdtemp(join(tmpdir(), 'reval-phys-')));
await chmod(root, 0o700);
const servers: Server[] = [];
after(async () => { for (const s of servers) s.close(); await rm(root, { recursive: true, force: true }); });

async function cluster(name: string) {
  const sockDir = join(root, name, 'sock'); const dataDir = join(root, name, 'data');
  await mkdir(sockDir, { recursive: true, mode: 0o700 }); await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const server = createServer(); servers.push(server);
  await new Promise<void>(r => server.listen(join(sockDir, '.s.PGSQL.5432'), r));
  const st = await stat(join(sockDir, '.s.PGSQL.5432'));
  const physical = { systemIdentifier: '7000000000000000001', databaseOid: '16384', postmasterStartTime: '1700000000', postmasterPid: String(process.pid),
    dataDirectory: dataDir, socketDevice: String(st.dev), socketInode: String(st.ino) };
  await writeFile(join(dataDir, 'postmaster.pid'), `${process.pid}\n${dataDir}\n1700000000\n5432\n${sockDir}\n\n  5432001  65536\nready   \n`);
  return { sockDir, dataDir, server, physical, expectation: { endpoint: { socketDir: sockDir, port: 5432, database: 'atlas' }, physical,
    role: 'atlas_rvr', applicationName: 'atlas-reval-c-reader', budgetMs: 1000 } };
}
interface Stub extends QueryClient { statements: string[]; ended: boolean }
const row = { system_identifier: '7000000000000000001', database_oid: '16384', start_epoch: '1700000000', database: 'atlas', session_user: 'atlas_rvr',
  unix_socket: true, backend_pid: '4242' };
const stubConnect = (over: Record<string, unknown> = {}, seen: ConnectOptions[] = []) => async (o: ConnectOptions): Promise<Stub> => {
  seen.push(o);
  const c: Stub = { statements: [], ended: false, query: async (sql: string) => { if (c.ended) throw new Error('used after end'); c.statements.push(sql); return { rows: [{ ...row, ...over }] }; },
    end: async () => { c.ended = true; } };
  last = c; return c;
};
let last: Stub | null = null;
const step = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => e instanceof PhysicalMismatchError ? e.step : String(e));

test('physical comparator: the exact unix-socket tuple passes; the client only ever gets host = socketDir', async () => {
  const c = await cluster('ok'); const seen: ConnectOptions[] = [];
  const { observed } = await verifyPhysicalEndpoint(c.expectation, 'Password1234567890', nodePhysicalDeps(stubConnect({}, seen)));
  assert.equal(observed.backendPid, '4242'); assert.equal(observed.unixSocket, true);
  assert.equal(seen[0]!.host, c.sockDir); assert.equal(seen[0]!.application_name, 'atlas-reval-c-reader');
  assert.equal(last!.statements.length, 1, 'only the fixed physical query');
  assert.equal(observed.postmasterStartTime, '1700000000', 'the start equals the recorded tuple and the postmaster.pid line exactly');
});

test('physical comparator: each fact mismatched alone, swaps, symlinks and TCP sessions → REGISTRATION_MISMATCH, connection destroyed first', async () => {
  const c = await cluster('neg');
  const deps = (over: Record<string, unknown> = {}) => nodePhysicalDeps(stubConnect(over));
  const run = (exp: typeof c.expectation, over: Record<string, unknown> = {}) => step(verifyPhysicalEndpoint(exp, 'Password1234567890', deps(over)));
  const withPhysical = (p: Partial<typeof c.physical>) => ({ ...c.expectation, physical: { ...c.physical, ...p } });
  assert.equal(await run(withPhysical({ socketInode: String(Number(c.physical.socketInode) + 1) })), 'socket', 'same system_identifier, other socket inode');
  assert.equal(await run(withPhysical({ socketDevice: '1' })), 'socket');
  assert.equal(await run(withPhysical({ dataDirectory: join(root, 'neg', 'other') })), 'pid-file', 'data directory');
  assert.equal(await run(withPhysical({ postmasterPid: '1' })), 'pid-file', 'postmaster pid');
  assert.equal(await run(withPhysical({ postmasterStartTime: '1700000001' })), 'pid-file', 'postmaster start');
  assert.equal(await run({ ...c.expectation, endpoint: { ...c.expectation.endpoint, port: 5433 } }), 'socket', 'port');
  assert.equal(await run({ ...c.expectation, endpoint: { ...c.expectation.endpoint, socketDir: join(root, 'neg', 'data') } }), 'socket', 'socket dir');
  for (const [over, why] of [[{ database_oid: '1' }, 'database oid'], [{ system_identifier: '1' }, 'system identifier'], [{ start_epoch: '1699999999' }, 'pg_postmaster_start_time -1 s'],
    [{ start_epoch: '1700000001' }, 'pg_postmaster_start_time +1 s'], [{ unix_socket: false }, 'inet_server_addr non-null (TCP session)'], [{ session_user: 'other' }, 'wrong session_user'],
    [{ database: 'other' }, 'database']] as const) {
    assert.equal(await run(c.expectation, over), 'database', why);
    assert.ok(last!.ended && last!.statements.length === 1, `${why}: destroyed, no further statement`);
  }
  // Socket replaced after recording (new inode at the same path).
  c.server.close(); await rm(join(c.sockDir, '.s.PGSQL.5432'), { force: true });
  const again = createServer(); servers.push(again); await new Promise<void>(r => again.listen(join(c.sockDir, '.s.PGSQL.5432'), r));
  assert.equal(await run(c.expectation), 'socket', 'socket replaced');
  // Symlinked socket dir, missing and partial pid file.
  const s = await cluster('sym');
  await symlink(s.sockDir, join(root, 'sym', 'link'));
  assert.equal(await step(verifyPhysicalEndpoint({ ...s.expectation, endpoint: { ...s.expectation.endpoint, socketDir: join(root, 'sym', 'link') } }, 'Password1234567890',
    deps())), 'socket-dir-path');
  await writeFile(join(s.dataDir, 'postmaster.pid'), `${process.pid}\n${s.dataDir}\n`);
  assert.equal(await step(verifyPhysicalEndpoint(s.expectation, 'Password1234567890', deps())), 'pid-file', 'partial pid file');
  await rm(join(s.dataDir, 'postmaster.pid'));
  assert.equal(await step(verifyPhysicalEndpoint(s.expectation, 'Password1234567890', deps())), 'pid-file', 'missing pid file');
  const w = await cluster('writable'); await chmod(join(root, 'writable'), 0o777);
  assert.equal(await step(verifyPhysicalEndpoint(w.expectation, 'Password1234567890', deps())), 'socket-dir-writable', 'attacker-writable ancestor');
  await chmod(join(root, 'writable'), 0o700);
});

test('connector errors stay classified (Sol R3 / Opus F2): credential refusals keep ONLY their SQLSTATE → E OWNER_REQUIRED; physical → REGISTRATION_MISMATCH; no text leaks', async () => {
  const c = await cluster('auth');
  const refusing = (code: string) => nodePhysicalDeps(async () => { throw Object.assign(new Error('password authentication failed for user "atlas_owner" SECRET-SENTINEL'), { code, severity: 'FATAL' }); });
  for (const code of ['28P01', '28000', '42501'] as const) {
    const e = await verifyPhysicalEndpoint(c.expectation, 'Password1234567890', refusing(code)).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof PhysicalAuthError && e.sqlState === code, code);
    assert.ok(!JSON.stringify({ m: (e as Error).message, ...(e as object) }).includes('SENTINEL'), `${code}: no server text`);
    const r = await runOwnerExec(execRequest(c), performance.now() + 1000, { now: () => performance.now(),
      readSecret: async () => Buffer.from('Password1234567890'), connect: productionExecConnect(refusing(code)) });
    assert.deepEqual([r.outcome, r.code], ['REFUSED', 'OWNER_REQUIRED'], `E ${code}`);
  }
  for (const code of ['3D000', '57P03']) {
    assert.ok(await verifyPhysicalEndpoint(c.expectation, 'Password1234567890', refusing(code)).then(() => false, x => x instanceof PhysicalMismatchError), `${code} → physical mismatch`);
  }
  assert.ok(await verifyPhysicalEndpoint(c.expectation, 'Password1234567890', nodePhysicalDeps(async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); }))
    .then(() => false, x => x instanceof PhysicalMismatchError), 'socket error → physical mismatch');
});

/** An executor request bound to a synthetic cluster (owner role = the stub's session_user). */
const execRequest = (c: Awaited<ReturnType<typeof cluster>>) => ({ challenge: crypto.randomUUID(), ownerSecretFile: '/unused', endpoint: c.expectation.endpoint,
  physical: c.physical, ownerRole: 'atlas_rvr' }) as never;
test('E connect timeout is brief §6 min(300, DE − now) THROUGH the production E connector (Sol RC2-F2 / Opus R2-F1): pg option and connect bound, short remaining, stalled connect; codes kept', async () => {
  const c = await cluster('ecap');
  const exec = async (deadlineMs: number, connect: (o: ConnectOptions) => Promise<QueryClient>) => {
    const t = performance.now();
    const r = await runOwnerExec(execRequest(c), t + deadlineMs, { now: () => performance.now(), readSecret: async () => Buffer.from('Password1234567890'),
      connect: productionExecConnect(nodePhysicalDeps(connect)) });
    return { r, ms: performance.now() - t };
  };
  const refuse = (seen: ConnectOptions[], code = '28P01') => async (o: ConnectOptions): Promise<QueryClient> => { seen.push(o); throw Object.assign(new Error('x'), { code, severity: 'FATAL' }); };
  assert.equal(E_CONNECT_TIMEOUT_MS, 300);
  for (const code of ['28P01', '28000', '42501']) {
    const seen: ConnectOptions[] = [];
    const { r } = await exec(1200, refuse(seen, code));
    assert.deepEqual([r.outcome, r.code], ['REFUSED', 'OWNER_REQUIRED'], code);
    assert.equal(seen[0]!.connectionTimeoutMillis, 300, `${code}: the pg connect timeout is the fixed 300 ms, not the ~1200 ms binding budget`);
    assert.ok(seen[0]!.statement_timeout > 300 && seen[0]!.statement_timeout <= 1200, `${code}: the binding budget is distinct (${seen[0]!.statement_timeout})`);
  }
  const short: ConnectOptions[] = [];
  await exec(120, refuse(short));
  assert.ok(short[0]!.connectionTimeoutMillis <= 120 && short[0]!.connectionTimeoutMillis >= 1, `short remaining → ${short[0]!.connectionTimeoutMillis} ≤ remaining`);
  // A stalled connect is cut at the 300 ms cap (E: REFUSED DEADLINE, nothing else ran), not at the 1200 ms deadline; the late client is destroyed.
  let late: Stub | null = null;
  const { r, ms } = await exec(1200, async o => { await new Promise(res => setTimeout(res, 700)); late = await stubConnect()(o); return late; });
  assert.deepEqual([r.outcome, r.code], ['REFUSED', 'DEADLINE']); assert.ok(ms >= 280 && ms < 450, `cut after ${ms.toFixed(0)} ms`);
  await new Promise(res => setTimeout(res, 600));
  assert.ok(late && (late as Stub).ended && (late as Stub).statements.length === 0, 'the late connection is destroyed unused');
  const wrong = await exec(1200, stubConnect({ database_oid: '1' }));
  assert.deepEqual([wrong.r.outcome, wrong.r.code], ['REFUSED', 'REGISTRATION_MISMATCH'], 'wrong physical tuple');
});

test('physical binding and recheck are bounded by ONE budget (Sol R1): a stalled physical query rejects in time, the client is destroyed, statement_timeout = the budget', async () => {
  const c = await cluster('stall');
  let opts: { statement_timeout?: number; connectionTimeoutMillis?: number } = {};
  const stalled = () => nodePhysicalDeps(async o => { opts = o; const st = await stubConnect()(o); st.query = () => new Promise(() => undefined); return st; });
  const t = performance.now();
  const e = await verifyPhysicalEndpoint({ ...c.expectation, budgetMs: 300 }, 'Password1234567890', stalled()).then(() => null, (x: unknown) => x);
  const ms = performance.now() - t;
  assert.ok(e instanceof DeadlineExceeded, String(e)); assert.ok(ms >= 290 && ms < 450, `${ms.toFixed(0)} ms`);
  assert.ok(last!.ended, 'the client of the stalled query is destroyed');
  assert.ok(opts.statement_timeout! > 0 && opts.statement_timeout! <= 300 && opts.connectionTimeoutMillis! <= 300, JSON.stringify(opts));
  const stuck = await stubConnect()({} as never); stuck.query = () => new Promise(() => undefined);
  const t2 = performance.now();
  assert.equal(await recheckPhysical({ ...c.expectation, budgetMs: 200 }, stuck, nodePhysicalDeps(stubConnect())), false);
  assert.ok(performance.now() - t2 < 350, 'recheck bounded');
  assert.equal(await recheckPhysical(c.expectation, await stubConnect()({} as never), nodePhysicalDeps(stubConnect())), true, 'control: an exact recheck passes');
});

const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const node = realpathSync(process.execPath);
test('Darwin peer proof: exact child pid/pidversion after its write; never a third process before it; channel keeps reading; grandchild, wrong exe, hang and changed incarnation refused', { skip: !darwin && 'darwin/arm64 only (elsewhere the controller refuses: see the gate test)' }, async () => {
  const built = buildPeer(join(root, 'peer-a')); const twice = buildPeer(join(root, 'peer-b'));
  assert.equal(built.sha256, twice.sha256, 'two clean builds with the fixed basename are byte-identical');
  await verifyHelperBinary(built.path, built.sha256);
  await assert.rejects(verifyHelperBinary(built.path, 'f'.repeat(64)), PeerError, 'sha ≠ pin');
  await productionDeps().warmHelper(built.path); // first exec of a freshly signed binary is assessed by the OS
  const child = spawn(process.execPath, ['-e', "setTimeout(()=>require('fs').writeSync(3,'x'),300);setTimeout(()=>require('fs').writeSync(3,'y'),1200);setTimeout(()=>{},3000)"], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const sock = child.stdio[3] as Socket;
  const wrote = new Promise(r => sock.once('data', r));
  // Measured (corrects the brief's raw-fork probe): libuv's child init already touches fd 3, so even before HELLO the token
  // names the creator or the child itself — never a third process. The protocol still proves only after HELLO.
  const before = await runPeerHelper(built.path, sock, node);
  assert.ok(before.pid === process.pid || before.pid === child.pid, 'creator or the child, never another process');
  await wrote;
  const facts = await runPeerHelper(built.path, sock, node);
  assert.ok(childPeerOk(facts, child.pid!), JSON.stringify(facts));
  assert.equal(facts.ppid, process.pid); assert.equal(facts.hasTty, false);
  assert.ok(sameIncarnation(facts, await runPeerHelper(built.path, sock, node)));
  const forged: PeerFacts = { ...facts, pidversion: facts.pidversion + 1 };
  assert.ok(!sameIncarnation(facts, forged), 'same pid, different pidversion → a different incarnation');
  assert.equal((await runPeerHelper(built.path, sock, '/usr/bin/false')).exeMatch, false, 'unexpected executable');
  assert.equal(String(await new Promise(r => sock.once('data', r))), 'y', 'the channel still reads after helper runs (raw fd passed, stream untouched)');
  child.kill();
  // A grandchild writing on the inherited channel is not the child.
  const parent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,['-e',\"require('fs').writeSync(3,'g');setTimeout(()=>{},2000)\"],{stdio:['ignore','ignore','ignore',3]});setTimeout(()=>{},2500)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const ps = parent.stdio[3] as Socket; await new Promise(r => ps.once('data', r));
  const g = await runPeerHelper(built.path, ps, node);
  assert.notEqual(g.pid, parent.pid); assert.ok(!childPeerOk(g, parent.pid!), 'grandchild rejected');
  parent.kill();
  // A helper that hangs is killed at 500 ms and is a helper failure.
  const hang = join(root, 'hang.sh'); await writeFile(hang, '#!/bin/sh\nsleep 5\n', { mode: 0o700 });
  const t0 = Date.now();
  await assert.rejects(runPeerHelper(hang, 0, node), PeerError);
  assert.ok(Date.now() - t0 < 1500, 'bounded');
});

class Exit extends Error { readonly code: number; constructor(code: number) { super(`exit ${code}`); this.code = code; } }
function gateDeps(over: Partial<ControllerDeps>, spies: string[]): ControllerDeps {
  const base = productionDeps();
  return { ...base, env: { ATLAS_REVAL_CONFIG: '/nonexistent/config.json', ATLAS_REVAL_CONNECTION_ID: crypto.randomUUID(), ATLAS_REVAL_SERVER_BOOT_ID: crypto.randomUUID() },
    loadConfig: async () => ({ nativePeerHelper: '/h', nativePeerHelperSha256: 'f'.repeat(64) }) as never,
    verifyHelper: async () => undefined, warmHelper: async () => undefined,
    ownerSocket: () => { spies.push('ownerSocket'); throw new Error('ownerSocket'); },
    connectReader: async () => { spies.push('db'); throw new Error('db'); },
    spawnServer: () => { spies.push('spawnServer'); throw new Error('spawn'); },
    spawnExecutor: () => { spies.push('spawnExecutor'); throw new Error('spawn'); },
    exit: (code: number) => { throw new Exit(code); }, ...over };
}
const exitOf = (deps: ControllerDeps) => createController(deps).run().then(() => -1, (e: Exit) => e.code);
test('controller gate: exactly the brief\'s local exits 10/11/12 — non-darwin/arm64 → 10; invalid launch env, unloadable config (no verifiable helper pin), helper pin/warm failure → 11 — BEFORE any owner channel, DB or spawn', async () => {
  assert.deepEqual(Object.values(CONTROLLER_EXIT).sort(), [10, 11, 12], 'no local exit code beyond the brief');
  for (const [over, code] of [[{ platform: 'linux' }, CONTROLLER_EXIT.PLATFORM], [{ arch: 'x64' }, CONTROLLER_EXIT.PLATFORM],
    [{ platform: 'linux', env: {} }, CONTROLLER_EXIT.PLATFORM],
    [{ env: { ATLAS_REVAL_CONFIG: 'relative', ATLAS_REVAL_CONNECTION_ID: 'x', ATLAS_REVAL_SERVER_BOOT_ID: 'y' } }, CONTROLLER_EXIT.HELPER],
    [{ loadConfig: async () => { throw new Error('config'); } }, CONTROLLER_EXIT.HELPER],
    [{ verifyHelper: async () => { throw new PeerError('HELPER'); } }, CONTROLLER_EXIT.HELPER],
    [{ warmHelper: async () => { throw new Error('warm'); } }, CONTROLLER_EXIT.HELPER]] as const) {
    const spies: string[] = [];
    assert.equal(await exitOf(gateDeps(Object.assign({ platform: 'darwin', arch: 'arm64' }, over) as Partial<ControllerDeps>, spies)), code, JSON.stringify(over));
    assert.deepEqual(spies, [], 'no owner channel, DB or spawn before the gate passed');
  }
});
