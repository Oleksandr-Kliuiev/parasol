import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLLER_EXIT } from '../packages/reval/codes.ts';
import { alive, controllerHarness, silentChild, stubClient, wrapperOf } from './support/reval-controller-harness.ts';
import type { StubClient } from './support/reval-controller-harness.ts';

// R-EVAL RS-A controller deadlines (Sol RC1 R1; brief §6/§9: ONE absolute 1800 ms budget per operation, answered before O's
// 2 s), the one-response/one-sequence rule and the byte cap through the REAL controller (Opus RC1 F1), and the pre-proof
// peer exit (Opus F3.5). Real AF_UNIX socket pair, O-side validation exactly as the owner CLI; stalls are injected spies.
const never = <T>() => new Promise<T>(() => undefined);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BUDGET = 1800;

test('initial physical binding stalls: authenticated FAILURE DEADLINE before 1800 ms, sticky, never a late reader/S/success; a late client is destroyed', async () => {
  let late: StubClient | null = null; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const h = await controllerHarness((ids, events, children) => ({
    connectReader: async () => { events.push('connect'); await gate; late = stubClient(() => wrapperOf(ids, 1)); return { client: late, observed: {} } as never; },
    spawnServer: () => { events.push('spawnServer'); const c = silentChild(); children.push(c); return c; },
  }), 'LAUNCH');
  try {
    const a = await h.request('SNAPSHOT');
    assert.equal(a.problem, null, 'validated by O (binding, sequence 1, challenge, instance)');
    assert.deepEqual([a.r!.kind, a.r!.payload], ['FAILURE', { code: 'DEADLINE' }]);
    assert.ok(a.ms < BUDGET, `answered in ${a.ms.toFixed(0)} ms`);
    release(); await sleep(50);
    assert.ok(late && (late as StubClient).destroyed, 'the late physical binding is destroyed, never assigned');
    const b = await h.request('IDENTITY');
    assert.deepEqual([b.problem, b.r!.payload], [null, { code: 'DEADLINE' }], 'sticky for the session; sequence 2 continues');
    assert.ok(b.ms < 200);
    assert.deepEqual(h.events.filter(e => e !== 'connect'), [], 'no S launch, no exit');
  } finally { h.eof(); await h.exited; h.cleanup(); }
});

test('reconnect stall after a reader loss: CENSUS_UNAVAILABLE before 1800 ms; IDENTITY physical recheck stall: IDENTITY_UNVERIFIED before 1800 ms, reader destroyed', async () => {
  const clients: StubClient[] = []; let calls = 0; let failNext = false;
  const h = await controllerHarness(ids => ({
    connectReader: async () => {
      calls += 1; if (calls === 2) return never();
      const c = stubClient(() => wrapperOf(ids, 1)); const q = c.query;
      c.query = async (sql: string) => { if (failNext && sql.includes('atlas_reval_snapshot')) { failNext = false; throw new Error('connection lost'); } return q(sql); };
      clients.push(c); return { client: c, observed: {} } as never;
    },
  }));
  try {
    assert.equal((await h.request('SNAPSHOT')).r!.kind, 'SNAPSHOT');
    failNext = true;
    const lost = await h.request('SNAPSHOT');
    assert.deepEqual([lost.problem, lost.r!.payload], [null, { code: 'CENSUS_UNAVAILABLE' }]);
    assert.ok(clients[0]!.destroyed, 'the failed reader is destroyed');
    const stalled = await h.request('SNAPSHOT');
    assert.deepEqual([stalled.problem, stalled.r!.payload], [null, { code: 'CENSUS_UNAVAILABLE' }], 'reconnect stall');
    assert.ok(stalled.ms < BUDGET, `answered in ${stalled.ms.toFixed(0)} ms`);
  } finally { h.eof(); await h.exited; h.cleanup(); }
  const reader: StubClient[] = [];
  const r = await controllerHarness((ids, events, children) => ({
    connectReader: async () => { const c = stubClient(() => wrapperOf(ids, 1)); reader.push(c); return { client: c, observed: {} } as never; },
    recheckReader: async () => never(),
    spawnServer: () => { events.push('spawnServer'); const c = silentChild(); children.push(c); return c; },
  }), 'LAUNCH');
  try {
    const id = await r.request('IDENTITY');
    assert.deepEqual([id.problem, id.r!.payload], [null, { code: 'IDENTITY_UNVERIFIED' }]);
    assert.ok(id.ms < BUDGET, `answered in ${id.ms.toFixed(0)} ms`);
    assert.ok(reader[0]!.destroyed, 'the reader with the stalled recheck is destroyed (no query left in flight)');
    await sleep(100);
    assert.ok(r.children.every(c => !alive(c)), 'S killed');
  } finally { r.eof(); await r.exited; r.cleanup(); }
});

test('owner EOF during each stall (initial binding, reconnect, IDENTITY recheck) cancels at once: bounded exit, S killed, late values disposed, no late S launch', async () => {
  for (const stage of ['initial', 'reconnect', 'recheck'] as const) {
    let late: StubClient | null = null; let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let calls = 0;
    const h = await controllerHarness((ids, events, children) => ({
      connectReader: async () => {
        calls += 1;
        if ((stage === 'initial' && calls === 1) || (stage === 'reconnect' && calls === 2)) { await gate; late = stubClient(() => wrapperOf(ids, 1)); return { client: late, observed: {} } as never; }
        const c = stubClient(() => wrapperOf(ids, 1)); return { client: c, observed: {} } as never;
      },
      recheckReader: async () => (stage === 'recheck' ? never<boolean>() : stage === 'reconnect' ? false : true),
      spawnServer: () => { events.push('spawnServer'); const c = silentChild(); children.push(c); return c; },
    }), 'LAUNCH');
    try {
      if (stage === 'recheck') assert.equal((await h.request('SNAPSHOT')).r!.kind, 'SNAPSHOT', 'startup (and its one S launch) completed first');
      if (stage === 'reconnect') { const f = await h.request('IDENTITY'); assert.deepEqual(f.r!.payload, { code: 'IDENTITY_UNVERIFIED' }, 'recheck false drops the reader'); }
      const spawnsBefore = h.events.filter(e => e === 'spawnServer').length;
      void h.request(stage === 'recheck' ? 'IDENTITY' : 'SNAPSHOT');
      await sleep(300);
      const t = performance.now(); h.eof();
      assert.equal(await Promise.race([h.exited, sleep(2500).then(() => -1)]), 0, `${stage}: C exits`);
      assert.ok(performance.now() - t < 1500, `${stage}: bounded cleanup (${(performance.now() - t).toFixed(0)} ms)`);
      release(); await sleep(50);
      if (late) assert.ok((late as StubClient).destroyed, `${stage}: late client destroyed`);
      assert.equal(h.events.filter(e => e === 'spawnServer').length, spawnsBefore, `${stage}: no late S launch`);
      await sleep(100);
      assert.ok(h.children.every(c => !alive(c)), `${stage}: S stopped`);
    } finally { h.cleanup(); }
  }
});

test('one response per request with exactly one sequence: an over-cap SNAPSHOT is O-validated CENSUS_LIMIT_EXCEEDED and the next request continues', async () => {
  let n = 700;
  const h = await controllerHarness(ids => ({ connectReader: async () => ({ client: stubClient(() => wrapperOf(ids, n)), observed: {} }) as never }));
  try {
    const big = await h.request('SNAPSHOT');
    assert.equal(big.problem, null, 'O accepts it: sequence 1 answers request 1');
    assert.deepEqual([big.r!.sequence, big.r!.kind, big.r!.payload], ['1', 'FAILURE', { code: 'CENSUS_LIMIT_EXCEEDED' }]);
    n = 10;
    const small = await h.request('SNAPSHOT');
    assert.deepEqual([small.problem, small.r!.sequence, small.r!.kind], [null, '2', 'SNAPSHOT'], 'continuity on the next request');
  } finally { h.eof(); await h.exited; h.cleanup(); }
});

test('pre-proof peer failure (O without TTY, helper error) exits with the brief\'s local 12 and sends no response frame', async () => {
  for (const peer of [async () => ({ pid: 1, pidversion: 1, euid: process.geteuid!(), ppid: 0, startSec: 1, startUsec: 0, hasTty: false, exeMatch: true }),
    async () => { throw new Error('helper'); }]) {
    const h = await controllerHarness(() => ({ peer: peer as never, connectReader: async () => { throw new Error('must not connect'); } }));
    try {
      const r = await h.request('SNAPSHOT');
      assert.equal(r.r, null, 'no response frame');
      assert.equal(await h.exited, CONTROLLER_EXIT.PEER);
      assert.deepEqual(h.events, ['exit 12']);
    } finally { h.cleanup(); }
  }
});
