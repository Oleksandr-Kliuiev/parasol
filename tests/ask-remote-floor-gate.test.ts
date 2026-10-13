import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { generateToken } from '../packages/auth/token.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { bearerCredential } from '../packages/ask/credential.ts';
import { AskRun, AskStopped } from '../packages/ask/service.ts';
import { RemoteCircuit } from '../packages/ask/remote/circuit.ts';
import { EgressUnknown } from '../packages/ask/remote/db.ts';
import type { RemoteAskPort } from '../packages/ask/remote/db.ts';
import { admitEgress, bindTaskDeadline, dispatchIntent, takeSettlement } from '../packages/ask/remote/dispatch.ts';
import { preparePayload } from '../packages/ask/remote/payload.ts';
import { runRemoteQuestion } from '../packages/ask/remote/service.ts';
import type { RemoteSeams } from '../packages/ask/remote/secret.ts';
import type { TransportResult } from '../packages/ask/remote/transport.ts';
import { source } from './support/ask-source.ts';

// ASK-REMOTE R-B RC2 R1 (Astra RC1 R1): the ORIGINAL 4500 ms floor is re-checked by the private dispatch boundary on the
// task-bound original deadline AFTER secret resolution and prepared-byte work, immediately before consumption/transport.
// Actual orchestration (runRemoteQuestion) + actual dispatch (admitEgress/dispatchIntent/takeSettlement); the DB port is an
// in-process stand-in (DB authority is proven by tests/pg/ask-remote-rc2.pg.test.ts). Controlled clocks and real busy
// waits; every case asserts the wire, the reply, the settlement input and that the owner drains.

const ADM = '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const ATTEMPT = { workspaceId: 'w', clientId: 'c', attemptId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', correlationId: '1b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b',
  admissionId: ADM, policyVersion: '5' };
const BODY = { contractVersion: 'AskRequestV2', requestId: '2b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question: 'Synthetic summary?', observationId: null,
  acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADM, policyVersion: '5', questionDataClass: 'SYNTHETIC' } };
const OK: TransportResult = { kind: 'RESPONSE', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ object: 'chat.completion', model: 'gpt-6-luna',
  service_tier: 'default', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"version":"AskRemoteIntentV1","intent":"SUMMARY"}' } }] })) };
const tick = () => new Promise(resolve => setImmediate(resolve));

interface Case { clock?: () => number; total?: number; afterCommit?: (run: AskRun) => void; resolve?: (run: AskRun) => string | null; egress?: 'unknown' }
async function flow(c: Case) {
  const budget = new AskBudget(); const owner = budget.reserve()!;
  const run = new AskRun(owner, new AskDeadline(c.total ?? 8000, c.clock));
  const events: string[] = []; const wire: number[] = [];
  const port: RemoteAskPort = {
    sourceMode: 'db', credential: bearerCredential, authenticate: async () => ({ workspaceId: 'w', actorId: 'a' }), capability: async () => ({ admissionId: ADM, policyVersion: '5' }),
    admit: async (_r, _i, _c, clientId, _f, consent) => ({ scope: { workspaceId: 'w', clientId }, epoch: '1', source: source(),
      policy: { admissionId: ADM, policyVersion: '5', priceRevision: 'p', secretRef: 'fixture://controlled' }, consent }),
    egress: async (_r, _i, _c, _a, prepared) => {
      if (c.egress === 'unknown') throw new EgressUnknown();
      const cap = await admitEgress(async () => ({ attempt: ATTEMPT, secretRef: 'fixture://controlled' }), prepared, run.signal);
      c.afterCommit?.(run);
      return cap;
    },
    settle: async (_h, cap) => { events.push(`settle:${takeSettlement(cap)?.outcome}`); },
    pause: async () => { events.push('pause'); return 6n; },
    publish: async (_r, _i, _c, _a, outcome) => { events.push(`publish:${outcome.event === 'completed' ? outcome.status : outcome.code}`); }
  };
  const seams: RemoteSeams = { resolveSecret: () => c.resolve ? c.resolve(run) : 'sk-controlled-synthetic-0123456789',
    transport: () => { wire.push(run.deadline.remaining()); return { result: Promise.resolve(OK), settled: Promise.resolve() }; } };
  const work = runRemoteQuestion(run, { port, seams, circuit: new RemoteCircuit() }, { authorization: `Bearer ${generateToken()}`, clientId: 'c', body: BODY });
  owner.hold(work.catch(() => undefined)); owner.finish();
  let reply: { status: number; json: string } | null = null; let error: unknown = null;
  try { reply = await work; } catch (e) { error = e; }
  await tick(); await tick();
  return { status: reply?.status ?? null, code: reply ? JSON.parse(reply.json).code ?? null : null, error, wire, events, active: budget.active, run };
}

test('exact 4500 at the post-resolution gate is admitted: one call, verified settlement, 200, owner drained', async () => {
  let now = 0;
  const r = await flow({ clock: () => now, afterCommit: () => { now = 3500; } });
  // The synthetic bank is empty, so the unchanged compiler honestly reports SUMMARY as INSUFFICIENT.
  assert.deepEqual([r.status, r.wire, r.events, r.active], [200, [4500], ['settle:USAGE_VERIFIED', 'publish:INSUFFICIENT'], 0]);
});

test('4499 after secret resolution (controlled 1 ms): never dispatched, 504 ASK_DEADLINE, only proven no-dispatch 0, no publication', async () => {
  let now = 0;
  const r = await flow({ clock: () => now, afterCommit: () => { now = 3500; }, resolve: () => { now = 3501; return 'sk-controlled-synthetic-0123456789'; } });
  assert.deepEqual([r.status, r.code, r.wire, r.events, r.active], [504, 'ASK_DEADLINE', [], ['settle:NO_DISPATCH'], 0]);
  assert.equal(r.run.deadline.remaining(), 4499, 'the ORIGINAL deadline object, never reset by the provider phase');
});

test('4499 reached during prepared-byte work after a resolver that returns at 4500: the last gate still refuses', async () => {
  let now = 0; let reads = 0; let armed = false;
  // The clock advances by 1 ms on the first original-deadline read after the key was resolved (the work between resolution
  // and consumption); the orchestration's earlier check saw 4500.
  const r = await flow({ clock: () => { if (armed && ++reads === 1) now = 3501; return now; }, afterCommit: () => { now = 3500; },
    resolve: () => { armed = true; return 'sk-controlled-synthetic-0123456789'; } });
  assert.deepEqual([r.status, r.code, r.wire, r.events, r.active], [504, 'ASK_DEADLINE', [], ['settle:NO_DISPATCH'], 0]);
});

test('real elapsed time in a slow resolver crosses the floor → no wire; the same flow without the delay dispatches', async () => {
  const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } };
  const slow = await flow({ total: 4500 + 60, resolve: () => { busy(120); return 'sk-controlled-synthetic-0123456789'; } });
  assert.deepEqual([slow.status, slow.code, slow.wire, slow.events, slow.active], [504, 'ASK_DEADLINE', [], ['settle:NO_DISPATCH'], 0]);
  const fast = await flow({ total: 4500 + 400 });
  assert.equal(fast.status, 200); assert.equal(fast.wire.length, 1); assert.ok(fast.wire[0]! >= 4500);
});

test('terminal during resolution → no wire, drain settles no-dispatch 0, nothing published; unknown COMMIT unchanged', async () => {
  const t = await flow({ resolve: run => { run.end(); return 'sk-controlled-synthetic-0123456789'; } });
  assert.ok(t.error instanceof AskStopped);
  assert.deepEqual([t.wire, t.events, t.active], [[], ['settle:NO_DISPATCH'], 0]);
  const u = await flow({ egress: 'unknown' });
  assert.deepEqual([u.status, u.code, u.wire, u.events, u.active], [503, 'ASK_REMOTE_UNAVAILABLE', [], ['publish:ASK_REMOTE_UNAVAILABLE'], 0],
    'no capability: no wire, no settlement (no refund), reservation left as committed or not');
});

test('the floor authority is task-bound: unbound tasks never mint; rebinding/caller phase cannot relax it', async () => {
  const task = new AbortController().signal;
  await assert.rejects(admitEgress(async () => ({ attempt: ATTEMPT, secretRef: 'x' }), preparePayload({ question: 'q', hasFocus: false }), task), /TASK_UNBOUND/);
  let now = 0;
  const d = new AskDeadline(8000, () => now);
  const other = new AskDeadline(60_000);
  now = 3501;
  const bound = new AbortController();
  bindTaskDeadline(bound.signal, d);
  assert.throws(() => bindTaskDeadline(bound.signal, other), /REBOUND/, 'a second, different (more lenient) deadline is refused');
  bindTaskDeadline(bound.signal, d);
  const cap = await admitEgress(async () => ({ attempt: ATTEMPT, secretRef: 'fixture://controlled' }), preparePayload({ question: 'q', hasFocus: false }), bound.signal);
  const sent: unknown[] = [];
  const seams: RemoteSeams = { resolveSecret: () => 'sk-controlled-synthetic-0123456789', transport: () => { sent.push(1); return { result: Promise.resolve(OK), settled: Promise.resolve() }; } };
  assert.deepEqual(await dispatchIntent(seams, cap, bound.signal, 2000, () => undefined), { kind: 'NOT_SENT', reason: 'FLOOR' }, 'a caller-supplied 2 s phase cannot relax the original floor');
  assert.equal(sent.length, 0);
  assert.equal(takeSettlement(cap)!.outcome, 'NO_DISPATCH');
});
