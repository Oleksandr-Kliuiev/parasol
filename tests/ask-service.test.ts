import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../fixtures/run-demo.ts';
import { actor, scope } from '../fixtures/gasta.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { AskFailure } from '../packages/ask/contracts.ts';
import { fixtureAskPort, fixtureSource } from '../packages/ask/fixture.ts';
import { MOCK_PLANNER } from '../packages/ask/planner.ts';
import type { AskPlanner } from '../packages/ask/planner.ts';
import { AskRun, AskStopped, runCapability, runQuestion } from '../packages/ask/service.ts';
import type { AskPort } from '../packages/ask/service.ts';
import { bearerCredential } from '../packages/ask/credential.ts';
import { observation, source } from './support/ask-source.ts';

// ASK-A Q3/Q5/Q6 (in-process): whole fixture-context validation before projection, the fixture port's synthetic authority
// and memory audit, step precedence, planner deadline/invalid/terminal handling and owner retention until settlement.

const TOKEN = 'synthetic-demo-token-0123456789';
const AUTH = `Bearer ${TOKEN}`;
const body = (question: string, observationId: string | null = null) =>
  ({ contractVersion: 'AskRequestV1', requestId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question, observationId });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const demo = await runDemo();
  const port = fixtureAskPort({ demo: async () => demo, demoToken: () => TOKEN, actor, scope });
  return { demo, port };
}
/** Mirrors serveAsk ownership: the flow is held by the owner, which finishes after publication. */
async function ask(budget: AskBudget, port: AskPort, planner: AskPlanner, input: { authorization: unknown; clientId: string; body: unknown }) {
  const owner = budget.reserve();
  assert.ok(owner, 'a slot is free');
  const work = runQuestion(new AskRun(owner), port, planner, input);
  owner.hold(work); owner.finish();
  const reply = await work; await tick();
  return reply;
}
async function capability(budget: AskBudget, port: AskPort, authorization: unknown) {
  const owner = budget.reserve()!;
  const work = runCapability(new AskRun(owner), port, authorization);
  owner.hold(work); owner.finish();
  const reply = await work; await tick();
  return reply;
}
const code = (reply: { status: number; json: string }) => (JSON.parse(reply.json) as { code?: string }).code;
const sourceInvalid = (fn: () => unknown, expected = 'ASK_SOURCE_INVALID') => assert.throws(fn, (e: unknown) => e instanceof AskFailure && e.code === expected);

test('fixture context is validated as a whole original read; any malformed part fails, caps are 413, nothing is repaired', async () => {
  const { context } = await runDemo();
  const read = fixtureSource(context, scope, null);
  assert.equal(read.page.length, 2); assert.equal(read.resources.length, 3); assert.equal(read.entities.size, 2); assert.equal(read.links.length, 2);
  const mutate = (fn: (c: any) => void) => { const copy = structuredClone(context) as any; fn(copy); return copy; };
  for (const broken of [
    mutate(c => { c.observations.items[1].id = c.observations.items[0].id; }),
    mutate(c => { c.observations.items[0].source = 'zendesk'; }),
    mutate(c => { c.observations.items[0].summary = null; }),
    mutate(c => { c.observations.items[0].severity = 'SEVERE'; }),
    mutate(c => { c.observations.items[0].kind = 'OTHER'; }),
    mutate(c => { c.observations.items[0].clientId = 'other'; }),
    mutate(c => { c.observations.items[0].occurredAt = 'yesterday'; }),
    mutate(c => { c.observations.items[0].status = 'RESOLVED'; }),
    mutate(c => { c.observations.items[0].id = 'x'.repeat(257); }),
    mutate(c => { c.observations.truncated = true; }),
    mutate(c => { c.people.push({ ...c.people[0] }); }),
    mutate(c => { c.devices[0].id = c.people[0].id; }),
    mutate(c => { c.links[0].entityKind = 'PERSON'; }),
    mutate(c => { c.links[0].status = 'CANDIDATE'; }),
    mutate(c => { c.resources.push(structuredClone(c.resources[0])); }),
    mutate(c => { c.resources[0].status = 'OK'; }),
    mutate(c => { c.resources[0].items = { not: 'an array' }; }),
    mutate(c => { c.resources[0].items[0].source = 'huntress'; }),
    mutate(c => { c.resources[1].items[0].title = 7; }),
    mutate(c => { c.resources[0].source = 'unknown-system'; }),
    mutate(c => { c.mode = 'db'; })]) sourceInvalid(() => fixtureSource(broken, scope, null));
  sourceInvalid(() => fixtureSource(mutate(c => { c.people = Array.from({ length: 1001 }, (_, i) => ({ ...c.people[0], id: `p${i}` })); }), scope, null), 'ASK_TOO_LARGE');
  sourceInvalid(() => fixtureSource(mutate(c => { c.resources[1].items = Array.from({ length: 1001 }, () => c.resources[1].items[0]); }), scope, null), 'ASK_TOO_LARGE');
  sourceInvalid(() => fixtureSource(mutate(c => { c.observations.items[0].summary = 'x'.repeat(4 * 1024 * 1024); }), scope, null), 'ASK_TOO_LARGE');
  const excluded = fixtureSource(mutate(c => { c.resources.push({ ...structuredClone(c.resources[0]), source: 'poweroffice', items: [] }); }), scope, null);
  assert.equal(excluded.resources.length, 3, 'a known non-Ask source is excluded, not repaired');
});

test('capability: authenticated, binds the actor without charging, no audit; malformed/unknown credential → 401', async () => {
  const { demo, port } = await fixture();
  const budget = new AskBudget();
  const before = demo.audit.list(scope).length;
  assert.deepEqual(JSON.parse((await capability(budget, port, AUTH)).json), { contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 });
  assert.equal(budget.admissions(actor.workspaceId, actor.id), 0);
  for (const auth of [undefined, '', `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, 'Bearer short']) {
    const reply = await capability(budget, port, auth);
    assert.equal(reply.status, 401); assert.equal(code(reply), 'ASK_AUTHENTICATION_FAILED');
  }
  assert.equal(demo.audit.list(scope).length, before); assert.equal(demo.securityAudit.list(scope.workspaceId).length, 0);
  assert.equal(budget.active, 0); assert.equal(budget.entries, 0); assert.equal(budget.releases, 6);
});

test('fixture question: cited answer, one memory ask.completed with allowlisted metadata only; denial → one workspace record, 403', async () => {
  const { demo, port } = await fixture();
  const budget = new AskBudget();
  const before = demo.audit.list(scope).length;
  const marker = 'QUESTION-SECRET-MARKER what needs attention';
  const ok = await ask(budget, port, MOCK_PLANNER, { authorization: AUTH, clientId: scope.clientId, body: body('What needs attention?') });
  assert.equal(ok.status, 200);
  const answer = JSON.parse(ok.json);
  assert.equal(answer.status, 'ANSWER'); assert.equal(answer.sourceMode, 'fixture'); assert.equal(answer.coverage.fixture, true);
  assert.deepEqual(answer.claims.map((c: { code: string }) => c.code), ['OBSERVATION_RECORDED', 'OBSERVATION_RECORDED']);
  const unsupported = await ask(budget, port, MOCK_PLANNER, { authorization: AUTH, clientId: scope.clientId, body: body(marker) });
  assert.equal(JSON.parse(unsupported.json).status, 'UNSUPPORTED');
  assert.ok(JSON.parse(unsupported.json).urgentRefs.length > 0, 'urgency is independent of the plan');
  assert.equal(unsupported.json.includes('QUESTION-SECRET'), false);
  const records = demo.audit.list(scope).slice(before);
  assert.deepEqual(records.map(r => [r.eventType, r.metadata]), [
    ['ask.completed', { provider: 'fixture', ruleVersion: 'ask-mock-v1', itemCount: '5', outcome: 'ANSWER' }],
    ['ask.completed', { provider: 'fixture', ruleVersion: 'ask-mock-v1', itemCount: '5', outcome: 'UNSUPPORTED' }]]);
  assert.equal(JSON.stringify(records).includes('QUESTION-SECRET'), false);
  for (const clientId of ['other-client', 'bad id!', '']) {
    const denied = await ask(budget, port, MOCK_PLANNER, { authorization: AUTH, clientId, body: body('What needs attention?') });
    assert.equal(denied.status, 403); assert.equal(code(denied), 'ASK_SCOPE_DENIED');
  }
  const security = demo.securityAudit.list(scope.workspaceId);
  assert.deepEqual(security.map(r => [r.eventType, r.reasonCode, r.requestedClientId, r.metadata]), [
    ['ask.scope_denied', 'SCOPE_DENIED', 'other-client', {}], ['ask.scope_denied', 'SCOPE_DENIED', 'bad id!', {}], ['ask.scope_denied', 'SCOPE_DENIED', '', {}]]);
  assert.equal(demo.audit.list(scope).length, before + 2, 'denials never write a client audit row');
  assert.equal(budget.admissions(actor.workspaceId, actor.id), 2, 'only admitted questions are charged');
});

/** Stub port recording the call order; its source is synthetic and its authority always admits unless told otherwise. */
function stubPort(options: { identity?: boolean; source?: ReturnType<typeof source> } = {}) {
  const calls: string[] = [];
  const port: AskPort = {
    sourceMode: 'db', credential: bearerCredential,
    async authenticate() { calls.push('authenticate'); return options.identity === false ? null : { workspaceId: 'w', actorId: 'a' }; },
    async admit(run) { calls.push('admit'); if (!run.owner.charge()) throw new AskFailure('ASK_BUSY'); return { scope: { workspaceId: 'w', clientId: 'c' }, epoch: '7', source: options.source ?? source({ page: [observation('o1', { severity: 'HIGH' })] }) }; },
    async publish(_run, _identity, _credential, _admission, outcome) { calls.push(`publish:${outcome.event}:${'code' in outcome ? outcome.code : outcome.status}`); }
  };
  return { port, calls };
}
const VALID_BEARER = 'Bearer abcdefghijklmnopqrstuvwxyz0123';

test('precedence: credential before body semantics before actor binding before phase1; no phase after a refusal', async () => {
  const budget = new AskBudget();
  const unauth = stubPort({ identity: false });
  assert.equal((await ask(budget, unauth.port, MOCK_PLANNER, { authorization: VALID_BEARER, clientId: 'c', body: { bad: 1 } })).status, 401);
  assert.equal((await ask(budget, unauth.port, MOCK_PLANNER, { authorization: 'Basic x', clientId: 'c', body: { bad: 1 } })).status, 401);
  assert.deepEqual(unauth.calls, ['authenticate'], 'a malformed bearer never reaches authentication');
  const ok = stubPort();
  const badBody = await ask(budget, ok.port, MOCK_PLANNER, { authorization: VALID_BEARER, clientId: 'c', body: { bad: 1 } });
  assert.equal(badBody.status, 400); assert.deepEqual(ok.calls, ['authenticate']);
  const holder = budget.reserve()!; assert.equal(holder.bind('w', 'a', false), 'BOUND');
  const busy = await ask(budget, ok.port, MOCK_PLANNER, { authorization: VALID_BEARER, clientId: 'c', body: body('what needs attention') });
  assert.equal(busy.status, 429); assert.equal(code(busy), 'ASK_BUSY'); assert.deepEqual(ok.calls, ['authenticate', 'authenticate']);
  assert.equal(budget.admissions('w', 'a'), 0, 'refusals are never charged');
});

test('planner: 2 s timeout publishes ask.failed 504 while the ignored-abort planner keeps the owner until it actually settles', async () => {
  const budget = new AskBudget();
  const { port, calls } = stubPort();
  const gate = deferred<unknown>();
  let aborted = false;
  const planner: AskPlanner = { plan: (_input, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return gate.promise; } };
  const owner = budget.reserve()!;
  const run = new AskRun(owner);
  const started = Date.now();
  const reply = await runQuestion(run, port, planner, { authorization: VALID_BEARER, clientId: 'c', body: body('what needs attention') });
  owner.finish();
  assert.ok(Date.now() - started >= 1900);
  assert.equal(reply.status, 504); assert.equal(code(reply), 'ASK_DEADLINE'); assert.equal(aborted, true);
  assert.deepEqual(calls, ['authenticate', 'admit', 'publish:failed:ASK_DEADLINE']);
  await tick();
  assert.equal(budget.active, 1, 'the abandoned planner still owns its slot');
  gate.resolve({ version: 'AskPlanV1', intent: 'SUMMARY', refs: ['E1'] }); await tick(); await tick();
  assert.equal(budget.active, 0); assert.equal(budget.releases, 1);
});

test('planner failures are ASK_PLANNER_INVALID with ask.failed; an exhausted original budget or a terminal run starts no final transaction', async () => {
  const budget = new AskBudget();
  for (const plan of [async () => { throw new Error('planner exploded: secret'); }, async () => ({ version: 'AskPlanV1', intent: 'SUMMARY', refs: ['E1'], tool: 'get_alert' }),
    async () => ({ version: 'AskPlanV1', intent: 'WHY_URGENT', refs: ['E1'] })]) {
    const { port, calls } = stubPort();
    const reply = await ask(budget, port, { plan }, { authorization: VALID_BEARER, clientId: 'c', body: body('x') });
    assert.equal(reply.status, 503); assert.equal(code(reply), 'ASK_PLANNER_INVALID'); assert.equal(reply.json.includes('secret'), false);
    assert.deepEqual(calls.at(-1), 'publish:failed:ASK_PLANNER_INVALID');
  }
  let now = 0;
  const { port, calls } = stubPort();
  const lateOwner = budget.reserve()!;
  const late = await runQuestion(new AskRun(lateOwner, new AskDeadline(8000, () => now)), port,
    { plan: async input => { now = 8000; return { version: 'AskPlanV1', intent: 'SUMMARY', refs: [input.bank[0]!.ref] }; } },
    { authorization: VALID_BEARER, clientId: 'c', body: body('x') });
  assert.equal(late.status, 504); assert.deepEqual(calls, ['authenticate', 'admit'], 'late planner result discarded, no new final transaction');
  lateOwner.finish(); await tick();
  const stopped = stubPort();
  const run = new AskRun(budget.reserve()!);
  await assert.rejects(runQuestion(run, stopped.port, { plan: async () => { run.end(); return { version: 'AskPlanV1', intent: 'UNSUPPORTED', refs: [] }; } },
    { authorization: VALID_BEARER, clientId: 'c', body: body('x') }), AskStopped);
  assert.deepEqual(stopped.calls, ['authenticate', 'admit'], 'no phase or audit after the terminal state');
});

test('an answer above 256 KiB fails closed 413 (no partial JSON) and is audited as an admitted failure', async () => {
  const wide = Array.from({ length: 24 }, (_, i) => observation(`o${i}`, { summary: '😀'.repeat(4000) }));
  const { port, calls } = stubPort({ source: source({ page: wide }) });
  const reply = await runQuestion(new AskRun(new AskBudget().reserve()!), port, MOCK_PLANNER, { authorization: VALID_BEARER, clientId: 'c', body: body('what needs attention') });
  assert.equal(reply.status, 413); assert.equal(code(reply), 'ASK_TOO_LARGE');
  assert.deepEqual(calls.at(-1), 'publish:failed:ASK_TOO_LARGE');
});
