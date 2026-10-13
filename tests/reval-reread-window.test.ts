import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { alive, controllerHarness, wrapperOf } from './support/reval-controller-harness.ts';
import type { Ids } from './support/reval-controller-harness.ts';
import type { QueryClient } from '../packages/reval/physical.ts';

// R-EVAL RS-A PAUSE_EXPORT reread window (Sol RC2-F1; brief §2e duplicate-frame abort + §6 post-request uncertainty) through the
// REAL controller and O-side validation. The executor child sends exactly ONE valid CONFIRMED_COMMIT result; then, while C's
// single reread is HELD OPEN, the test gates ONE anomaly from it and releases the reread only after C's own socket has
// delivered those bytes (deterministic: the observer is registered after C's channel listener, so C has processed them).
// Any anomaly in that interval → CONTAINMENT_UNCONFIRMED + persistent latch, never a closure; the next PAUSE_EXPORT never
// spawns. Control: the same single result followed by the executor's NORMAL exit (EOF) closes, and the session stays unlatched.
const gated = fileURLToPath(new URL('./support/reval-gated-executor.ts', import.meta.url));
const PAUSE = (ids: Ids) => ({ admissionId: ids.adm, expectedPolicyVersion: '1', policyFloor: '1', fenceFloor: '1' });
const CLOSURE = (ids: Ids) => ({ admissionId: ids.adm, paused: true, policyVersion: '2', fenceEpoch: '2' });

async function session(mode: string) {
  let child: ChildProcess | null = null; let spawns = 0; let rereads = 0;
  const wrapper = (ids: Ids) => { const w = wrapperOf(ids, 1) as { snapshot: Record<string, unknown> };
    Object.assign(w.snapshot, { policyState: 'PAUSED', policyVersion: '2', fenceEpoch: '2' }); return w; };
  const h = await controllerHarness((ids, events, children) => ({
    peer: async (_h: string, channel: unknown) => channel === 3
      ? { pid: 1, pidversion: 1, euid: process.geteuid!(), ppid: 0, startSec: 1, startUsec: 0, hasTty: true, exeMatch: true }
      : { pid: child!.pid!, pidversion: 1, euid: process.geteuid!(), ppid: process.pid, startSec: 1, startUsec: 0, hasTty: false, exeMatch: true },
    spawnExecutor: () => {
      spawns += 1; events.push('spawnExecutor');
      child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', gated, mode], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
      children.push(child); return child;
    },
    connectReader: async () => {
      let snapshots = 0;
      const client: QueryClient = { end: async () => undefined, query: async (sql: string) => {
        if (!sql.includes('atlas_reval_snapshot')) return { rows: [] };
        if (snapshots++ === 0 || !child) return { rows: [{ w: wrapperOf(ids, 1) }] }; // the startup wrapper
        rereads += 1;
        // The reread of a PAUSE_EXPORT: E's single result was already received; gate the anomaly (or await E's normal EOF).
        const sock = child.stdio[3] as Socket;
        if (mode === 'normal') { if (!sock.destroyed) await once(sock, 'close'); }
        else { const seen = once(sock, 'data'); child.stdin!.write('go\n'); await seen; }
        return { rows: [{ w: wrapper(ids) }] };
      } };
      return { client, observed: {} } as never;
    },
  }));
  return { h, spawns: () => spawns, rereads: () => rereads, child: () => child };
}

test('a duplicate, partial, oversize or malformed frame from E AFTER its valid result and BEFORE the reread completes → no closure, persistent latch, no later spawn', async () => {
  for (const mode of ['duplicate', 'partial', 'oversize', 'malformed']) {
    const s = await session(mode);
    try {
      const a = await s.h.request('PAUSE_EXPORT', PAUSE(s.h.ids));
      assert.equal(a.problem, null, `${mode}: O validates the response (binding, next sequence, challenge, instance)`);
      assert.deepEqual([a.r!.sequence, a.r!.kind, a.r!.payload], ['1', 'FAILURE', { code: 'CONTAINMENT_UNCONFIRMED' }], mode);
      assert.equal(s.rereads(), 1, `${mode}: the anomaly arrived during the (single) reread`);
      const b = await s.h.request('PAUSE_EXPORT', PAUSE(s.h.ids));
      assert.deepEqual([b.problem, b.r!.sequence, b.r!.payload], [null, '2', { code: 'CONTAINMENT_UNCONFIRMED' }], `${mode}: latched`);
      assert.equal(s.spawns(), 1, `${mode}: the latched session never spawns E again`);
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!alive(s.child()!), `${mode}: the executor child was reaped`);
    } finally { s.h.eof(); await s.h.exited; s.h.cleanup(); }
  }
});

test('control: the SAME single valid result followed by E\'s NORMAL exit (EOF) during the reread closes; no latch, the next PAUSE_EXPORT spawns again', async () => {
  const s = await session('normal');
  try {
    const a = await s.h.request('PAUSE_EXPORT', PAUSE(s.h.ids));
    assert.deepEqual([a.problem, a.r!.sequence, a.r!.kind, a.r!.payload], [null, '1', 'CLOSURE', CLOSURE(s.h.ids)], 'normal completion is not a violation');
    const b = await s.h.request('PAUSE_EXPORT', PAUSE(s.h.ids));
    assert.deepEqual([b.problem, b.r!.sequence, b.r!.kind], [null, '2', 'CLOSURE']);
    assert.deepEqual([s.spawns(), s.rereads()], [2, 2], 'not latched: a second executor, a second reread');
  } finally { s.h.eof(); await s.h.exited; s.h.cleanup(); }
});
