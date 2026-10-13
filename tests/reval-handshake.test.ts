import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameDecoder, parseFrameBody, PRIVATE_FRAME_CAP } from '../packages/reval/frame.ts';
import { pauseExport } from '../packages/reval/pause.ts';
import type { PauseContext } from '../packages/reval/pause.ts';
import { ServerLink } from '../packages/reval/server-link.ts';
import { PHYSICAL, wrapperOf } from './support/reval-controller-harness.ts';
import { snapshotFitsEnvelope } from '../packages/reval/snapshot-reader.ts';
import type { SnapshotWrapper } from '../packages/reval/payloads.ts';

// R-EVAL RS-A private handshake phases (brief §2e; Sol RC1 R2, Opus RC1 F3.1). ENDPOINTS: the production S bridge and E
// executor libraries in real child processes with credential/connect spies — a duplicate (coalesced or fragmented), early,
// wrong-phase or missing launch/request frame exits BEFORE the secret read/connect; a duplicate while the secret read is
// pending exits before the connect. CONTROLLER SIDE: scripted children — a missing HELLO, a frame before HELLO or a duplicate
// HELLO fails before any launch/request frame is sent to them; a duplicate executor result after the request latches.
// Limit (disclosed): phases are RECEIVE phases; a frame C wrote before receiving HELLO is not distinguishable by S (the launch
// frame carries no nonce by contract), while E rejects any request not echoing its own helloNonce.
const spyChild = fileURLToPath(new URL('./support/reval-spy-child.ts', import.meta.url));
const scripted = fileURLToPath(new URL('./support/reval-scripted-child.ts', import.meta.url));
const common = { registrationId: randomUUID(), databaseInstanceId: randomUUID(), endpoint: { socketDir: '/unused', port: 5432, database: 'atlas' }, physical: PHYSICAL };
// RS-C-A: the controller's launch frame is RevalServerLaunchV2 (V1 fields + registered workspace, Ask REMOTE, handoff socket, pinned helper).
const launch = () => ({ ...common, contractVersion: 'RevalServerLaunchV2', serverBootId: randomUUID(), connectionId: randomUUID(), launchChallenge: randomUUID(),
  runtimeRole: 'atlas_runtime', runtimeSecretFile: '/unused/runtime', workspaceId: 'ws', askMode: 'remote', handoffSocketPath: '/unused/reval-handoff.sock',
  nativePeerHelper: '/unused/reval-peer', nativePeerHelperSha256: 'a'.repeat(64) });
const request = (nonce: string) => ({ ...common, contractVersion: 'RevalOwnerExecRequestV1', helloNonce: nonce, challenge: randomUUID(), remainingMs: 1000,
  workspaceId: 'ws', clientId: 'cl', actorId: 'ac', admissionId: randomUUID(), expectedPolicyVersion: '1', ownerRole: 'atlas_owner', ownerSecretFile: '/unused/owner' });

type Plan = (sock: Socket, frame: Buffer, out: () => string) => Promise<void> | void;
async function endpoint(kind: 'S' | 'E', plan: Plan, readMs = 0, nonce?: (hello: string) => string): Promise<{ code: number | null; spies: string[]; ms: number }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', spyChild, kind, String(readMs)],
    { stdio: ['ignore', 'pipe', 'ignore', 'pipe'], env: kind === 'S' ? { ATLAS_MODE: 'db', ATLAS_REVAL_BRIDGE_FD: '3' } : {} });
  let out = ''; child.stdout!.on('data', b => { out += b; });
  const sock = child.stdio[3] as Socket; sock.on('error', () => undefined);
  const dec = new FrameDecoder(PRIVATE_FRAME_CAP); let t = 0;
  sock.on('data', b => { for (const body of dec.push(b)) {
    const h = parseFrameBody(body) as { contractVersion: string; helloNonce: string };
    if (h.contractVersion !== 'RevalChildHelloV1') continue;
    t = performance.now();
    const f = encodeFrame(kind === 'S' ? launch() : request(nonce ? nonce(h.helloNonce) : h.helloNonce), PRIVATE_FRAME_CAP);
    void plan(sock, f, () => out);
  } });
  const killer = setTimeout(() => child.kill('SIGKILL'), 6000);
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  clearTimeout(killer);
  return { code, spies: out.trim().split('\n').filter(Boolean), ms: performance.now() - t };
}
const waitFor = async (out: () => string, s: string) => { const t = Date.now(); while (!out().includes(s) && Date.now() - t < 3000) await new Promise(r => setTimeout(r, 5)); };

test('S and E endpoints: duplicate (coalesced, fragmented), wrong-phase and missing launch/request frames exit before ANY secret read or connect', async () => {
  for (const kind of ['S', 'E'] as const) {
    const protocolExit = kind === 'S' ? 42 : 22;
    const control = await endpoint(kind, (s, f, out) => { s.write(f); void waitFor(out, 'CONNECT').then(() => s.destroy()); });
    assert.deepEqual(control.spies, ['READ_SECRET', 'CONNECT'], `${kind} control: one valid frame reaches the credential and connect spies`);
    const cases: [string, Plan][] = [
      ['coalesced duplicate', (s, f) => { s.write(Buffer.concat([f, f])); }],
      ['fragmented duplicate', (s, f) => { s.write(Buffer.concat([f, f.subarray(0, 9)])); setTimeout(() => s.write(f.subarray(9)), 50); }],
      ['wrong-phase frame', s => { s.write(encodeFrame({ contractVersion: 'RevalOwnerCommandV1' }, PRIVATE_FRAME_CAP)); }],
      ['missing launch/request', () => undefined]];
    for (const [label, plan] of cases) {
      const r = await endpoint(kind, plan);
      assert.deepEqual([r.code, r.spies], [protocolExit, []], `${kind} ${label}`);
    }
    // Duplicate while the secret read is pending: exits before the connect (the read had legitimately begun).
    const pending = await endpoint(kind, async (s, f, out) => { s.write(f); await waitFor(out, 'READ_SECRET'); s.write(f); }, 400);
    assert.deepEqual([pending.code, pending.spies], [protocolExit, ['READ_SECRET']], `${kind} duplicate while pending`);
  }
  const forged = await endpoint('E', (s, f) => { s.write(f); }, 0, () => randomUUID());
  assert.deepEqual([forged.code, forged.spies], [22, []], 'E: a request not echoing its own helloNonce (produced before/without HELLO)');
});

function child(mode: string, kind: 'S' | 'E', sink: ChildProcess[]): ChildProcess {
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', scripted, mode, kind], { stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
  sink.push(c); return c;
}
const received = (c: ChildProcess): Promise<string[]> => new Promise(r => { let o = ''; c.stdout!.on('data', b => { o += b; }); setTimeout(() => r(o.trim().split('\n').filter(Boolean)), 300); });
const deps = (spawnOne: () => ChildProcess) => ({ now: () => performance.now(), nodeRealpath: '/n',
  peer: async (_h: string, _s: unknown) => ({ pid: last!.pid!, pidversion: 1, euid: process.geteuid!(), ppid: process.pid, startSec: 1, startUsec: 0, hasTty: false, exeMatch: true }),
  spawnServer: () => (last = spawnOne()), spawnExecutor: () => (last = spawnOne()) });
let last: ChildProcess | null = null;
const config = { ...common, registrationId: common.registrationId, workspaceId: 'ws', clientId: 'cl', actorId: 'ac', admissionId: randomUUID(), nativePeerHelper: '/h',
  roles: { reader: 'r', runtime: 'u', owner: 'o' }, secretFiles: { reader: '/a', runtime: '/b', owner: '/c' }, server: { mode: 'LAUNCH', apiEntry: '/x', port: 3999 } };

test('controller side: missing HELLO, a frame before HELLO and a duplicate HELLO fail before any launch/request frame; a duplicate executor result latches', async () => {
  const sink: ChildProcess[] = [];
  try {
    for (const mode of ['silent', 'other-first', 'hello-twice']) {
      const s = new ServerLink(deps(() => child(mode, 'S', sink)) as never, config as never, randomUUID(), () => null, '/tmp/reval-unused/owner.json');
      const t = performance.now();
      assert.equal(await s.ready, false, `S ${mode}`);
      assert.ok(performance.now() - t < 1500, `S ${mode}: bounded (${(performance.now() - t).toFixed(0)} ms)`);
      assert.deepEqual(await received(last!), [], `S ${mode}: no launch frame was sent`);
      assert.ok(last!.signalCode !== null || last!.exitCode !== null || last!.killed, `S ${mode}: killed`);
      const ctx: PauseContext = { deps: deps(() => child(mode, 'E', sink)) as never, config: config as never, latched: false, spawns: 0, lastChild: null, requestSent: false, reread: async () => null };
      const d = await pauseExport(ctx, { admissionId: config.admissionId, expectedPolicyVersion: '1', policyFloor: '0', fenceFloor: '0' }, performance.now());
      assert.deepEqual([d.kind, (d as { latch?: boolean }).latch, ctx.requestSent, ctx.spawns], ['FAILURE', false, false, 1], `E ${mode}: before the request, no latch`);
      assert.deepEqual(await received(last!), [], `E ${mode}: no request frame was sent`);
    }
    const ctx: PauseContext = { deps: deps(() => child('double-result', 'E', sink)) as never, config: config as never, latched: false, spawns: 0, lastChild: null, requestSent: false, reread: async () => null };
    const d = await pauseExport(ctx, { admissionId: config.admissionId, expectedPolicyVersion: '1', policyFloor: '0', fenceFloor: '0' }, performance.now());
    assert.deepEqual(d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'duplicate result after the request: commit-uncertain');
    assert.ok(ctx.latched && ctx.requestSent);
    assert.deepEqual(await received(last!), ['RECV RevalOwnerExecRequestV1'], 'exactly one request was sent');
  } finally { for (const c of sink) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }
});

test('byte cap at the reread (Opus RC1 F1): after a CONFIRMED commit an over-cap census → CONTAINMENT_UNCONFIRMED + latch, never a closure; a small census closes', async () => {
  const sink: ChildProcess[] = [];
  const reread = (n: number): SnapshotWrapper => {
    const w = wrapperOf({ reg: config.registrationId, inst: config.databaseInstanceId, adm: config.admissionId, boot: '', conn: '' }, n) as { snapshot: Record<string, unknown> };
    Object.assign(w.snapshot, { policyState: 'PAUSED', policyVersion: '2', fenceEpoch: '2' });
    return w as unknown as SnapshotWrapper;
  };
  assert.deepEqual([snapshotFitsEnvelope(reread(700)), snapshotFitsEnvelope(reread(10))], [false, true], 'the same reader-level measure as SNAPSHOT');
  try {
    for (const [n, expected] of [[10, { kind: 'CLOSURE', closure: { admissionId: config.admissionId, paused: true, policyVersion: '2', fenceEpoch: '2' } }],
      [700, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }]] as const) {
      const ctx: PauseContext = { deps: deps(() => child('confirmed', 'E', sink)) as never, config: config as never, latched: false, spawns: 0, lastChild: null, requestSent: false,
        reread: async () => reread(n) };
      const d = await pauseExport(ctx, { admissionId: config.admissionId, expectedPolicyVersion: '1', policyFloor: '1', fenceFloor: '1' }, performance.now());
      assert.deepEqual(d, expected, `census of ${n}`);
      assert.equal(ctx.latched, n === 700);
    }
  } finally { for (const c of sink) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }
});
