import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken } from '../packages/auth/token.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { bearerCredential } from '../packages/ask/credential.ts';
import { AskRun, AskStopped } from '../packages/ask/service.ts';
import { RemoteCircuit } from '../packages/ask/remote/circuit.ts';
import type { RemoteAskPort } from '../packages/ask/remote/db.ts';
import { admitEgress, takeSettlement } from '../packages/ask/remote/dispatch.ts';
import { runRemoteQuestion } from '../packages/ask/remote/service.ts';
import { createDirectTransport } from '../packages/ask/remote/transport.ts';
import { fakeHttp } from './support/ask-remote-http-fake.ts';
import type { Script } from './support/ask-remote-http-fake.ts';
import { source } from './support/ask-source.ts';

// ASK-REMOTE R-B RC2 R2 (Astra RC1 R2): an upstream non-200 status is final at the response HEADERS inside the active
// provider phase, independent of an oversized/stalled/failed/aborted body. Actual direct transport (createDirectTransport
// with an in-process https.request stand-in: the real TLS socket is NOT exercised) → actual dispatch → actual orchestration;
// the DB port is an in-process stand-in. Every non-200 is 503 ASK_REMOTE_UNAVAILABLE with UPSTREAM_REJECTED (whole reserve);
// 401/403 close the local circuit at detection and pause after phase2; zero retry; late status/body after the phase or
// terminal is never classified; ignored destroys keep the owner until BOTH request and response close.

const ADM = '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const ATTEMPT = { workspaceId: 'w', clientId: 'c', attemptId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', correlationId: '1b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b',
  admissionId: ADM, policyVersion: '5' };
const BODY = { contractVersion: 'AskRequestV2', requestId: '2b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question: 'Synthetic summary?', observationId: null,
  acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADM, policyVersion: '5', questionDataClass: 'SYNTHETIC' } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function flow(script: Script, opts: { endAt?: number } = {}) {
  const budget = new AskBudget(); const owner = budget.reserve()!;
  const run = new AskRun(owner, new AskDeadline(8000, () => 3000));
  const events: string[] = []; const circuit = new RemoteCircuit();
  const port: RemoteAskPort = {
    sourceMode: 'db', credential: bearerCredential, authenticate: async () => ({ workspaceId: 'w', actorId: 'a' }), capability: async () => ({ admissionId: ADM, policyVersion: '5' }),
    admit: async (_r, _i, _c, clientId, _f, consent) => ({ scope: { workspaceId: 'w', clientId }, epoch: '1', source: source(),
      policy: { admissionId: ADM, policyVersion: '5', priceRevision: 'p', secretRef: 'fixture://controlled' }, consent }),
    egress: async (_r, _i, _c, _a, prepared) => admitEgress(async () => ({ attempt: ATTEMPT, secretRef: 'fixture://controlled' }), prepared, run.signal),
    settle: async (_h, cap) => { events.push(`settle:${takeSettlement(cap)?.outcome}${circuit.allows('w', 5n) ? '' : ':circuit-closed'}`); },
    pause: async () => { events.push('pause'); return 6n; },
    publish: async (_r, _i, _c, _a, outcome) => { events.push(`publish:${outcome.event === 'completed' ? outcome.status : outcome.code}`); }
  };
  const http = fakeHttp(script);
  const seams = { resolveSecret: () => 'sk-controlled-synthetic-0123456789', transport: createDirectTransport(http.fn) };
  if (opts.endAt !== undefined) setTimeout(() => run.end(), opts.endAt);
  const work = runRemoteQuestion(run, { port, seams, circuit }, { authorization: `Bearer ${generateToken()}`, clientId: 'c', body: BODY });
  owner.hold(work.catch(() => undefined)); owner.finish();
  let reply: { status: number; json: string } | null = null; let error: unknown = null;
  try { reply = await work; } catch (e) { error = e; }
  await sleep(20);
  return { status: reply?.status ?? null, code: reply ? JSON.parse(reply.json).code ?? null : null, error, events, circuitOpen: circuit.allows('w', 5n), budget, http: http.h };
}

test('401/403 with oversized/stalled/error/aborted/small bodies: 503 UNAVAILABLE, UPSTREAM_REJECTED, circuit closed at detection, pause after phase2', async () => {
  for (const status of [401, 403]) {
    for (const body of ['oversized', 'stalled', 'error', 'aborted', 'small'] as const) {
      const started = Date.now();
      const r = await flow({ status, body });
      const label = `${status}/${body}`;
      assert.deepEqual([r.status, r.code], [503, 'ASK_REMOTE_UNAVAILABLE'], label);
      assert.deepEqual(r.events, ['settle:UPSTREAM_REJECTED:circuit-closed', 'publish:ASK_REMOTE_UNAVAILABLE', 'pause'], label);
      assert.equal(r.circuitOpen, false, label); assert.equal(r.http.calls, 1, `${label}: no retry`);
      assert.ok(Date.now() - started < 1500, `${label}: classified at the headers, not at the 2 s phase end`);
      assert.ok(r.http.bodyWritten <= 65537 + 64 || body !== 'oversized', label);
      assert.equal(r.budget.active, 0, `${label}: owner released only after request and response closed`);
      assert.ok(r.http.requestClosed && r.http.responseClosed, label);
    }
  }
});

test('404/429/5xx/3xx with bad bodies: 503 UNAVAILABLE, UPSTREAM_REJECTED, no pause, circuit stays open, no retry', async () => {
  for (const status of [404, 429, 500, 502, 503, 301, 400]) {
    for (const body of ['oversized', 'stalled', 'error'] as const) {
      const r = await flow({ status, body, type: 'text/html' });
      const label = `${status}/${body}`;
      assert.deepEqual([r.status, r.code, r.events, r.circuitOpen, r.http.calls, r.budget.active],
        [503, 'ASK_REMOTE_UNAVAILABLE', ['settle:UPSTREAM_REJECTED', 'publish:ASK_REMOTE_UNAVAILABLE'], true, 1, 0], label);
    }
  }
});

test('200 controls: valid answers; 64 KiB+1 overflow, fatal UTF-8 and duplicate keys are INVALID with the whole reserve', async () => {
  const ok = await flow({ status: 200, body: 'valid' });
  assert.deepEqual([ok.status, ok.events], [200, ['settle:USAGE_VERIFIED', 'publish:INSUFFICIENT']]);
  for (const body of ['oversized', 'utf8', 'dup'] as const) {
    const r = await flow({ status: 200, body });
    assert.deepEqual([r.status, r.code, r.events, r.circuitOpen, r.budget.active],
      [503, 'ASK_REMOTE_INVALID', ['settle:DELIVERY_UNKNOWN', 'publish:ASK_REMOTE_INVALID'], true, 0], body);
  }
});

test('late: a 200 body or a 401 status after the 2 s provider phase is discarded (never parsed/classified); no pause', async () => {
  for (const [script, label] of [[{ status: 200, body: 'late' }, '200 late body'], [{ status: 200, body: 'stalled' }, '200 stalled body'],
    [{ status: 401, body: 'small', headerDelay: 2300 }, '401 late status']] as const) {
    const r = await flow(script as Script);
    assert.deepEqual([r.status, r.code, r.events, r.circuitOpen], [503, 'ASK_REMOTE_UNAVAILABLE', ['settle:DELIVERY_UNKNOWN', 'publish:ASK_REMOTE_UNAVAILABLE'], true], label);
    await sleep(400);
    assert.equal(r.budget.active, 0, `${label}: drained`);
  }
});

test('terminal before the headers: a later 401 is not classified; drain keeps the whole reserve; nothing published or paused', async () => {
  const r = await flow({ status: 401, body: 'small', headerDelay: 150 }, { endAt: 40 });
  assert.ok(r.error instanceof AskStopped);
  assert.deepEqual([r.events, r.circuitOpen], [['settle:DELIVERY_UNKNOWN'], true]);
  await sleep(300); assert.equal(r.budget.active, 0);
});

test('ignored destroys: the owner is held until BOTH the request and the response physically close (either order)', async () => {
  for (const order of ['request-first', 'response-first'] as const) {
    const r = await flow({ status: 401, body: 'stalled', ignoreDestroy: true });
    assert.deepEqual([r.status, r.code, r.circuitOpen], [503, 'ASK_REMOTE_UNAVAILABLE', false]);
    assert.equal(r.events.at(-1), 'pause');
    await sleep(50);
    assert.equal(r.budget.active, 1, `${order}: still held while both are open`);
    if (order === 'request-first') r.http.closeRequest(); else r.http.closeResponse();
    await sleep(50);
    assert.equal(r.budget.active, 1, `${order}: one close is not enough`);
    if (order === 'request-first') r.http.closeResponse(); else r.http.closeRequest();
    await sleep(50);
    assert.equal(r.budget.active, 0, `${order}: released after both closed`);
  }
});
