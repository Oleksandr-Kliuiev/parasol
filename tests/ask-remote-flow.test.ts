import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken } from '../packages/auth/token.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { askFailure } from '../packages/ask/contracts.ts';
import { bearerCredential } from '../packages/ask/credential.ts';
import { AskRun, AskStopped } from '../packages/ask/service.ts';
import { AskRemoteFailure } from '../packages/ask/remote/contracts.ts';
import { RemoteCircuit } from '../packages/ask/remote/circuit.ts';
import { EgressUnknown } from '../packages/ask/remote/db.ts';
import type { RemoteAskPort } from '../packages/ask/remote/db.ts';
import { admitEgress, takeSettlement } from '../packages/ask/remote/dispatch.ts';
import { runRemoteCapability, runRemoteQuestion } from '../packages/ask/remote/service.ts';
import type { RemoteSeams } from '../packages/ask/remote/secret.ts';
import type { TransportResult } from '../packages/ask/remote/transport.ts';
import { observation, source, found } from './support/ask-source.ts';

// ASK-REMOTE R-B orchestration ORDER and OWNERSHIP (in-process seam: a scripted stand-in for the DB port whose egress mints
// through the REAL admitEgress and whose settlement takes the REAL private settlement inputs). It proves sequencing, the
// pre-dispatch terminal/floor/circuit gate, settlement-before-publication, pause-after-publication and owner retention;
// it does NOT prove database authority, which tests/pg/ask-remote-*.pg.test.ts prove on real PostgreSQL.

const TOKEN = generateToken();
const ADM = '3f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const ATTEMPT = { workspaceId: 'w', clientId: 'c', attemptId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', correlationId: '1b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b',
  admissionId: ADM, policyVersion: '5' };
const body = (patch: Record<string, unknown> = {}) => ({ contractVersion: 'AskRequestV2', requestId: '2b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b',
  question: 'Почему это срочно?', observationId: 'o1', acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADM, policyVersion: '5',
    questionDataClass: 'SYNTHETIC' }, ...patch });
const envelope = (patch: (e: any) => void = () => undefined): TransportResult => {
  const e: any = { object: 'chat.completion', model: 'gpt-6-luna', service_tier: 'default', usage: { prompt_tokens: 400, completion_tokens: 10, total_tokens: 410 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"version":"AskRemoteIntentV1","intent":"WHY_URGENT"}' } }] };
  patch(e);
  return { kind: 'RESPONSE', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(e)) };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Options {
  egress?: (run: AskRun, mint: () => Promise<any>) => Promise<any>; settle?: () => Promise<void>; pause?: () => Promise<bigint>;
  result?: () => TransportResult | Promise<TransportResult>;
}
function harness(o: Options = {}) {
  const log: string[] = [];
  const sent: string[] = [];
  const circuit = new RemoteCircuit();
  const focus = observation('o1', { severity: 'HIGH' });
  const port: RemoteAskPort = {
    sourceMode: 'db', credential: bearerCredential,
    authenticate: async () => { log.push('auth'); return { workspaceId: 'w', actorId: 'a' }; },
    capability: async () => { log.push('capability'); return { admissionId: ADM, policyVersion: '5' }; },
    admit: async (run, _i, _c, clientId, _f, consent, allows) => {
      log.push('admit');
      if (consent.policyVersion !== '5') throw new AskRemoteFailure('ASK_REMOTE_POLICY_CHANGED');
      if (!allows('w', 5n)) throw new AskRemoteFailure('ASK_REMOTE_UNAVAILABLE');
      if (!run.owner.charge()) askFailure('ASK_BUSY');
      return { scope: { workspaceId: 'w', clientId }, epoch: '1', source: source({ page: [focus], focus: found(focus) }),
        policy: { admissionId: ADM, policyVersion: '5', priceRevision: 'p-1', secretRef: 'env://ATLAS_ASK_REMOTE_KEY' }, consent: { ...consent } };
    },
    egress: (run, _i, _c, _a, prepared) => {
      log.push('egress');
      const mint = () => admitEgress(async () => ({ attempt: ATTEMPT, secretRef: 'env://ATLAS_ASK_REMOTE_KEY' }), prepared, run.signal);
      return o.egress ? o.egress(run, mint) : mint();
    },
    settle: async (_hold, capability) => {
      const taken = takeSettlement(capability);
      log.push(`settle:${taken?.outcome}${circuit.allows('w', 5n) ? '' : ':circuit-closed'}`);
      if (o.settle) await o.settle();
    },
    pause: async (_hold, _attempt, reason) => { log.push(`pause:${reason}`); return o.pause ? o.pause() : 6n; },
    publish: async (_run, _i, _c, _a, outcome) => { log.push(`publish:${outcome.event === 'completed' ? outcome.status : outcome.code}`); }
  };
  const seams: RemoteSeams = { resolveSecret: () => 'sk-synthetic-ask-remote-key-0123456789', transport: (bytes, _key, signal) => {
    sent.push(bytes.toString('utf8'));
    log.push('wire');
    const result = Promise.resolve().then(o.result ?? (() => envelope()));
    void signal;
    return { result, settled: result.then(() => undefined) };
  } };
  const budget = new AskBudget();
  const deps = { port, seams, circuit };
  async function ask(b: unknown = body(), deadline?: AskDeadline) {
    const owner = budget.reserve()!;
    const run = new AskRun(owner, deadline);
    const work = runRemoteQuestion(run, deps, { authorization: `Bearer ${TOKEN}`, clientId: 'c', body: b });
    owner.hold(work.catch(() => undefined)); owner.finish();
    try { const reply = await work; await tick(); return { reply, code: JSON.parse(reply.json).code as string | undefined, owner }; }
    catch (error) { await tick(); return { error, owner }; }
  }
  return { log, sent, circuit, budget, deps, ask };
}

test('success: auth → admit → egress → wire → settlement → phase2 audit → V2 answer; question + hasFocus only on the wire', async () => {
  const h = harness();
  const { reply } = await h.ask();
  assert.equal(reply!.status, 200);
  assert.deepEqual(h.log, ['auth', 'admit', 'egress', 'wire', 'settle:USAGE_VERIFIED', 'publish:ANSWER']);
  const json = JSON.parse(reply!.json);
  assert.equal(json.contractVersion, 'AskAnswerV2'); assert.equal(json.intent, 'WHY_URGENT'); assert.equal(json.claims[0].code, 'SOURCE_URGENT');
  assert.deepEqual(JSON.parse(JSON.parse(h.sent[0]!).messages[1].content), { question: 'Почему это срочно?', hasFocus: true });
  for (const marker of ['o1', 'Synthetic o1', ADM, ATTEMPT.attemptId, ATTEMPT.correlationId, '"w"', 'ext-o1']) assert.equal(h.sent[0]!.includes(marker), false, marker);
  assert.equal(h.budget.active, 0);
  const owner = h.budget.reserve()!;
  const cap = await runRemoteCapability(new AskRun(owner), h.deps, `Bearer ${TOKEN}`); owner.finish();
  assert.equal(JSON.parse(cap.json).contractVersion, 'AskCapabilityV2');
});

test('V1/malformed requests are 400 before any admission; stale consent is 409 before egress; nothing is sent', async () => {
  const h = harness();
  assert.equal((await h.ask({ contractVersion: 'AskRequestV1', requestId: body().requestId, question: 'q', observationId: null })).reply!.status, 400);
  assert.deepEqual(h.log, ['auth']);
  const stale = await h.ask(body({ acknowledgement: { ...body().acknowledgement, policyVersion: '4' } }));
  assert.equal(stale.reply!.status, 409); assert.equal(stale.code, 'ASK_REMOTE_POLICY_CHANGED');
  assert.equal(h.log.includes('egress'), false); assert.equal(h.sent.length, 0);
});

test('egress refusals: decided codes are audited by phase2; floor/deadline is 504 without audit; unknown commit never dispatches', async () => {
  const budget = harness({ egress: async () => { throw new AskRemoteFailure('ASK_REMOTE_BUDGET'); } });
  assert.equal((await budget.ask()).reply!.status, 429);
  assert.deepEqual(budget.log, ['auth', 'admit', 'egress', 'publish:ASK_REMOTE_BUDGET']);
  const floor = harness({ egress: async () => askFailure('ASK_DEADLINE') });
  assert.equal((await floor.ask()).reply!.status, 504);
  assert.deepEqual(floor.log, ['auth', 'admit', 'egress']);
  const unknown = harness({ egress: async () => { throw new EgressUnknown(); } });
  const u = await unknown.ask();
  assert.equal(u.reply!.status, 503); assert.equal(u.code, 'ASK_REMOTE_UNAVAILABLE');
  assert.deepEqual(unknown.log, ['auth', 'admit', 'egress', 'publish:ASK_REMOTE_UNAVAILABLE'], 'no wire and no settlement: no capability, no refund');
});

test('after commit: terminal or floor <4500 → proven no-dispatch settle 0; exact 4500 dispatches; no publication after terminal', async () => {
  const terminal = harness({ egress: async (run, mint) => { const c = await mint(); run.end(); return c; } });
  const t = await terminal.ask();
  assert.ok(t.error instanceof AskStopped);
  assert.deepEqual(terminal.log, ['auth', 'admit', 'egress', 'settle:NO_DISPATCH']);
  let now = 0;
  const clock = () => now;
  const floor = harness({ egress: async (_run, mint) => { const c = await mint(); now = 8000 - 4499; return c; } });
  const f = await floor.ask(body(), new AskDeadline(8000, clock));
  assert.equal(f.reply!.status, 504);
  assert.deepEqual(floor.log, ['auth', 'admit', 'egress', 'settle:NO_DISPATCH']);
  now = 0;
  const exact = harness({ egress: async (_run, mint) => { const c = await mint(); now = 8000 - 4500; return c; } });
  const e = await exact.ask(body(), new AskDeadline(8000, clock));
  assert.equal(e.reply!.status, 200);
  assert.deepEqual(exact.log, ['auth', 'admit', 'egress', 'wire', 'settle:USAGE_VERIFIED', 'publish:ANSWER']);
});

test('faults: circuit closes before settlement; pause runs after phase2 and is owner-held; 401/403 pause; 5xx/invalid do not', async () => {
  const mismatch = harness({ result: () => envelope(e => { e.model = 'gpt-6-luna-2026-10-01'; }) });
  const m = await mismatch.ask();
  assert.equal(m.reply!.status, 503); assert.equal(m.code, 'ASK_REMOTE_MODEL_MISMATCH');
  assert.deepEqual(mismatch.log, ['auth', 'admit', 'egress', 'wire', 'settle:MODEL_MISMATCH:circuit-closed', 'publish:ASK_REMOTE_MODEL_MISMATCH', 'pause:MODEL_MISMATCH']);
  const again = await mismatch.ask();
  assert.equal(again.code, 'ASK_REMOTE_UNAVAILABLE', 'local circuit refuses new work of the workspace');
  assert.equal(mismatch.circuit.allows('w', 7n), true, 'a later owner revision than the committed pause reopens');
  for (const [status, code, paused] of [[401, 'ASK_REMOTE_UNAVAILABLE', true], [403, 'ASK_REMOTE_UNAVAILABLE', true], [500, 'ASK_REMOTE_UNAVAILABLE', false],
    [429, 'ASK_REMOTE_UNAVAILABLE', false], [404, 'ASK_REMOTE_UNAVAILABLE', false]] as const) {
    const h = harness({ result: () => ({ ...envelope(), status }) });
    const r = await h.ask();
    assert.equal(r.reply!.status, 503); assert.equal(r.code, code);
    assert.equal(h.log.includes('pause:UPSTREAM_AUTH'), paused, String(status));
    assert.equal(h.log.at(-1), paused ? 'pause:UPSTREAM_AUTH' : `publish:${code}`);
  }
  const usage = harness({ result: () => envelope(e => { e.usage.total_tokens = 0; }) });
  assert.equal((await usage.ask()).code, 'ASK_REMOTE_USAGE_INVALID'); assert.equal(usage.log.at(-1), 'pause:USAGE_INVALID');
  const refusal = harness({ result: () => envelope(e => { e.choices[0].message.refusal = 'no'; }) });
  const r = await refusal.ask();
  assert.equal(r.code, 'ASK_REMOTE_INVALID', 'a refusal is never a successful UNSUPPORTED answer');
  assert.deepEqual(refusal.log.slice(-2), ['settle:USAGE_VERIFIED', 'publish:ASK_REMOTE_INVALID'], 'verified usage still settles the known cost');
  const unsupported = harness({ result: () => envelope(e => { e.choices[0].message.content = '{"version":"AskRemoteIntentV1","intent":"UNSUPPORTED"}'; }) });
  const un = await unsupported.ask();
  assert.equal(un.reply!.status, 200); assert.equal(JSON.parse(un.reply!.json).status, 'UNSUPPORTED');
  const failedPause = harness({ result: () => ({ ...envelope(), status: 403 }), pause: async () => { throw new Error('pause failed'); } });
  await failedPause.ask();
  assert.equal(failedPause.circuit.allows('w', 999n), false, 'a failed pause never opens local calls');
});

test('settlement: a failure does not suppress a valid answer; a stuck settlement is waited ≤ remaining−500 ms and keeps the owner', async () => {
  const failing = harness({ settle: async () => { throw new Error('settlement failed'); } });
  assert.equal((await failing.ask()).reply!.status, 200);
  let release!: () => void;
  let now = 0;
  const clock = () => now;
  // The settlement starts with 520 ms of the original budget left: the caller waits ~20 ms, then publishes.
  const stuck = harness({ settle: () => { now = 8000 - 520; return new Promise<void>(resolve => { release = resolve; }); } });
  const started = Date.now();
  const outcome = await stuck.ask(body(), new AskDeadline(8000, clock));
  assert.ok(Date.now() - started < 1000, 'bounded by remaining − 500 ms, not by the 2 s settlement clock');
  assert.equal(outcome.reply!.status, 200, 'published after the bounded wait');
  assert.equal(stuck.budget.active, 1, 'the owner still holds the unsettled financial transaction');
  release(); await tick(); await tick();
  assert.equal(stuck.budget.active, 0);
});
