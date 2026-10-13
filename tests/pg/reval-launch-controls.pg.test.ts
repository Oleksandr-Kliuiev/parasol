import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createTestDatabase } from '../support/pg-harness.ts';
import { launchHarness } from '../support/reval-launch-harness.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { alive, childrenOf, waitGone } from '../support/reval-pty.ts';
import type { Result } from '../support/reval-pty.ts';

// R-EVAL RS-A launch-level controls on darwin/arm64 with a REAL PTY (O = production owner CLI library; C = production
// controller with the Docker TCP seam; S = built bridge): Sol RC1 R1 (deadline stalls on the REAL reader backend, owner EOF
// during each, bounded process/backend cleanup), Sol R4 (S on another otherwise-ready DB; forged Bound.observed) and Opus
// F3.5 (O's locally mapped display of the controller's actual exits 10/11/12). "bogus" marks the send time of the next command.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only' };
const n = await nonsuperDatabase();
const other = await createTestDatabase();
after(async () => { await other.drop(); await n.cleanup(); });
const lh = await launchHarness(n);
const { admin, db } = n;
const lines = (r: readonly Result[]) => r.map(x => x.line);
const gap = (r: readonly Result[], i: number) => r[i]!.at - r[i - 1]!.at;
const sleepers = async () => Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-c-reader'
  AND query LIKE '%pg_sleep%' AND state = 'active'`, [db.name])).rows[0].n);
const until = async (pred: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await new Promise(r => setTimeout(r, 50)); } return pred(); };
const listening = (port: number) => new Promise<boolean>(r => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
const pidOf = async (file: string) => Number(JSON.parse(await readFile(file, 'utf8')).pid);

test('R4: reader correct, S directed to ANOTHER otherwise-ready database → S refuses before listen; a forged Bound.observed → S killed before listen', skip, async () => {
  for (const [label, extra] of [['other database', { serverDatabase: other.name }], ['forged observed', { forgeObservedOid: '1' }]] as const) {
    const s = await lh.session('LAUNCH', () => ['snapshot', ...Array.from({ length: 6 }, () => 'identity'), 'snapshot', 'quit'], extra);
    try {
      assert.ok(await s.pty.exited(40000), `${label}: session ended`);
      const r = lines(s.pty.results);
      assert.match(r[0]!, /^OK SNAPSHOT /, `${label}: control — the reader is correctly bound`);
      assert.ok(r.slice(1, 7).every(l => l === 'FAILURE IDENTITY_UNVERIFIED'), `${label}: never a server identity: ${r.join(' | ')}`);
      assert.match(r[7]!, /^OK SNAPSHOT /);
      const sPid = await pidOf(s.probes.serverFdProbe);
      assert.ok(await waitGone([sPid], 3000), `${label}: S is gone`);
      assert.equal(await listening(s.serverPort), false, `${label}: S never listened`);
    } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  }
});

test('R1: initial physical binding stalls on the real backend → authenticated FAILURE DEADLINE before 2 s, sticky; no S; the stalled backend is cancelled', skip, async () => {
  const s = await lh.session('LAUNCH', () => ['bogus', 'snapshot', 'identity', 'quit'], { stallConnectCall: 1 });
  try {
    assert.ok(await s.pty.exited(30000));
    const r = s.pty.results;
    assert.deepEqual(lines(r), ['REFUSED GRAMMAR', 'FAILURE DEADLINE', 'FAILURE DEADLINE'], 'C answered (O would have ended the session on its own timeout)');
    assert.ok(gap(r, 1) < 2000 && gap(r, 1) > 1200, `first answer after ${gap(r, 1).toFixed(0)} ms`);
    await assert.rejects(readFile(s.probes.serverFdProbe), 'no S was ever started');
    assert.ok(await until(async () => await sleepers() === 0, 3000), 'the stalled reader backend is gone');
  } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
});

test('R1: IDENTITY physical recheck stall → IDENTITY_UNVERIFIED before 2 s (S killed); reconnect stall → CENSUS_UNAVAILABLE before 2 s; then the session recovers', skip, async () => {
  const s = await lh.session('LAUNCH', () => ['bogus', 'identity', 'snapshot', 'snapshot', 'quit'], { stallRecheck: true, stallConnectCall: 2 });
  try {
    assert.ok(await s.pty.exited(30000));
    const r = s.pty.results;
    assert.deepEqual(lines(r).slice(0, 3), ['REFUSED GRAMMAR', 'FAILURE IDENTITY_UNVERIFIED', 'FAILURE CENSUS_UNAVAILABLE']);
    assert.match(r[3]!.line, /^OK SNAPSHOT /, 'a fresh reader binds on the next operation');
    for (const i of [1, 2]) assert.ok(gap(r, i) < 2000, `answer ${i} after ${gap(r, i).toFixed(0)} ms`);
    assert.ok(await waitGone([await pidOf(s.probes.serverFdProbe)], 3000), 'S killed');
    assert.ok(await until(async () => await sleepers() === 0, 3000), 'no stalled reader backend survives');
  } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
});

test('R1: owner EOF (O killed) during the initial-binding stall and during the IDENTITY recheck stall → C exits within 1.5 s, S stopped, backends gone, no late S', skip, async () => {
  for (const [label, extra, cmds, waitLine] of [
    ['initial binding', { stallConnectCall: 1 }, ['bogus', 'snapshot'], 'REFUSED GRAMMAR'],
    ['IDENTITY recheck', { stallRecheck: true }, ['snapshot', 'bogus', 'identity'], 'REFUSED GRAMMAR']] as const) {
    const s = await lh.session('LAUNCH', () => [...cmds], extra);
    try {
      await s.pty.waitFor(x => x.line === waitLine, 30000);
      await new Promise(r => setTimeout(r, 500));
      const cPid = await pidOf(s.probes.controllerFdProbe);
      const sPid = await pidOf(s.probes.serverFdProbe).catch(() => 0);
      const oPids = childrenOf(s.pty.child.pid!).filter(alive);
      assert.ok(oPids.length > 0, `${label}: O found`);
      for (const p of oPids) process.kill(p, 'SIGKILL');
      const t = Date.now();
      assert.ok(await waitGone([cPid], 1500), `${label}: C exited after owner EOF (${Date.now() - t} ms)`);
      if (sPid) assert.ok(await waitGone([sPid], 1500), `${label}: S stopped`);
      else await assert.rejects(readFile(s.probes.serverFdProbe), `${label}: no late S launch`);
      assert.ok(await until(async () => await sleepers() === 0, 3000), `${label}: the stalled reader backend is gone`);
    } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  }
});

test('F3.5: the controller\'s ACTUAL exits 10/11/12 are shown by O as LOCAL codes, never as a C response; nothing touched the database', skip, async () => {
  for (const [label, extra, over, exit, shown] of [
    ['non-darwin platform', { forcePlatform: 'linux' }, {}, '10', 'LOCAL PLATFORM_UNVERIFIED'],
    ['helper sha ≠ config pin', {}, { helperSha256: 'f'.repeat(64) }, '11', 'LOCAL IDENTITY_UNVERIFIED'],
    ['parent proof: O without TTY', { parentWithoutTty: true }, {}, '12', 'LOCAL IDENTITY_UNVERIFIED']] as const) {
    const s = await lh.session('LAUNCH', () => ['identity', 'snapshot'], extra, over);
    try {
      assert.ok(await s.pty.exited(30000), label);
      assert.deepEqual(lines(s.pty.results).filter(l => !l.startsWith('REFUSED')), [shown], label);
      assert.equal(await readFile(s.probes.exitCodeFile, 'utf8'), exit, `${label}: C's actual exit code`);
      await assert.rejects(readFile(s.probes.serverFdProbe), `${label}: no S`);
      const secretReads = await readFile(s.probes.secretLog, 'utf8').catch(() => '');
      assert.equal(secretReads, '', `${label}: no secret read, no DB`);
    } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  }
});
