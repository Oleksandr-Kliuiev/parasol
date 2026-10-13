import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { EvaluationGate, RECEIPT_HEADER, SESSION_HEADER } from '../packages/reval/eval-gate.ts';
import type { RegisteredTask } from '../packages/reval/eval-gate.ts';
import { GuardCensus } from '../packages/reval/eval-census.ts';
import { TerminalObserver } from '../packages/reval/eval-observer.ts';
import { EvaluationState } from '../packages/reval/eval-state.ts';
import { newToken } from '../packages/reval/eval-wire.ts';
import { askRequest, TestClock } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A ingress gate (rs-c/IMPLEMENTATION_BRIEF.md §4–§5; 04 "Registration lifetime and exact Ask ingress pipeline"):
// header-only decisions BEFORE body/bearer/DB/budget for the registered client's question POST, the one claim of a READY arm,
// the sticky integrity stop, and the claimed task's scope/focus/slot/receipt hooks. Pure; fake request headers only.
const PORT = 3700;
const REG = { registrationId: randomUUID(), databaseInstanceId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor-reval',
  admissionId: randomUUID() };
const FOCUS: Record<string, string | null> = { FX02: null, FX05: 'obs-synthetic-5' };
function setup() {
  const clock = new TestClock();
  const state = new EvaluationState({ ...REG, serverBootId: randomUUID() }, clock);
  const observer = new TerminalObserver(clock);
  const phases = { phase1: async () => new Date(), recheck: async () => undefined };
  const census = new GuardCensus(); census.attach(state, observer);
  const gate = new EvaluationGate({ reg: REG, serverBootId: randomUUID(), guardEpoch: census.guardEpoch, port: PORT, state, observer, census,
    requestedFocus: id => FOCUS[id] ?? null, phases: () => phases });
  return { clock, state, observer, gate, census };
}
/** Pair + READY arm for `fixtureId`; returns the session token. */
function ready(s: ReturnType<typeof setup>, fixtureId = 'FX02'): { session: string; armId: string; handoff: string } {
  const nonce = newToken(); const pairId = randomUUID(); const handoff = randomUUID();
  s.state.install(pairId, randomUUID(), handoff, nonce, s.clock.wall() + 60_000);
  const p = s.state.browserPair(nonce, { credential: 'c'.repeat(64), admissionId: REG.admissionId, policyVersion: '3', fixtureGeneration: '1',
    admissionExpiresMs: s.clock.wall() + 86_400_000, credentialExpiresMs: null }); assert.ok(typeof p !== 'string');
  const caseId = `case-${randomUUID().slice(0, 6)}`;
  assert.equal(s.state.seeCase(caseId), null);
  const a = s.state.armCase({ caseId, fixtureId, fixtureGeneration: '1', admissionId: REG.admissionId, policyVersion: '3',
    preSnapshotId: randomUUID(), browserPairId: pairId }, { fixtureId, fixtureGeneration: '1', admissionId: REG.admissionId, policyVersion: '3', policyActive: true,
    admissionExpiresMs: s.clock.wall() + 86_400_000, priorCollected: true });
  assert.ok(typeof a !== 'string');
  assert.equal(s.state.ready(handoff, a.armId, '1', randomUUID()), null);
  return { session: p.sessionToken, armId: a.armId, handoff };
}
const good = (session: string | string[] | null, over: Record<string, string | string[] | undefined> = {}) => {
  const h: Record<string, string | string[] | undefined> = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', 'content-length': '300', ...(session === null ? {} : { [SESSION_HEADER]: session }), ...over };
  const headers: Record<string, string> = {}; const headersDistinct: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) { headersDistinct[k] = Array.isArray(v) ? v : [v]; headers[k] = Array.isArray(v) ? v.join(', ') : v; }
  return { headers, headersDistinct } as unknown as IncomingMessage;
};
const verdict = (a: ReturnType<EvaluationGate['admit']>) => a.kind === 'reject' ? `${a.status} ${a.code}` : a.kind;

test('capability and foreign-scope requests: the evaluation header is 400; without it the ordinary pipeline continues untouched', () => {
  const s = setup();
  assert.equal(verdict(s.gate.admit(good(null), 'capability', null, false)), 'pass');
  assert.equal(verdict(s.gate.admit(good(newToken()), 'capability', null, false)), '400 ASK_REQUEST_INVALID');
  assert.equal(verdict(s.gate.admit(good(null), 'question', 'other-client', false)), 'pass');
  assert.equal(verdict(s.gate.admit(good(newToken()), 'question', 'other-client', false)), '400 ASK_REQUEST_INVALID');
  assert.equal(s.state.counters.ingress, 0, 'not registered-client ingress');
});

test('registered question POST: every header problem is rejected before any read; pre-GO/foreign token → 503; one READY arm → exactly one claim', () => {
  const s = setup();
  const cases: [IncomingMessage, boolean, string][] = [
    [good(null), false, '503 ASK_REMOTE_NOT_ADMITTED'], [good([newToken(), newToken()]), false, '400 ASK_REQUEST_INVALID'], [good('not-a-token'), false, '400 ASK_REQUEST_INVALID'],
    [good(newToken(), { host: `localhost:${PORT}` }), false, '400 ASK_REQUEST_INVALID'], [good(newToken(), { origin: 'http://evil.test' }), false, '400 ASK_REQUEST_INVALID'],
    [good(newToken(), { origin: undefined }), false, '400 ASK_REQUEST_INVALID'], [good(newToken(), { 'sec-fetch-site': 'cross-site' }), false, '400 ASK_REQUEST_INVALID'],
    [good(newToken()), true, '400 ASK_REQUEST_INVALID'], [good(newToken(), { 'content-type': 'text/plain' }), false, '400 ASK_REQUEST_INVALID'],
    [good(newToken(), { 'content-encoding': 'gzip' }), false, '400 ASK_REQUEST_INVALID'], [good(newToken(), { 'content-length': '16385' }), false, '413 ASK_TOO_LARGE'],
    [good(newToken(), { 'content-length': '1e3' }), false, '400 ASK_REQUEST_INVALID'], [good(newToken()), false, '503 ASK_REMOTE_NOT_ADMITTED'],
  ];
  for (const [req, query, want] of cases) assert.equal(verdict(s.gate.admit(req, 'question', REG.clientId, query)), want);
  assert.deepEqual([s.state.counters.ingress, s.state.counters.rejectedUnpairedCount, s.state.counters.claimed], [cases.length, cases.length, 0]);
  const r = ready(s);
  assert.equal(verdict(s.gate.admit(good(newToken()), 'question', REG.clientId, false)), '503 ASK_REMOTE_NOT_ADMITTED', 'stolen/foreign token');
  assert.equal(verdict(s.gate.admit(good(r.session, { origin: 'http://127.0.0.1:1' }), 'question', REG.clientId, false)), '400 ASK_REQUEST_INVALID', 'header problems never claim');
  assert.equal(s.state.arm?.state, 'READY');
  assert.equal(verdict(s.gate.admit(good(r.session), 'question', REG.clientId, false)), 'claimed');
  assert.equal(verdict(s.gate.admit(good(r.session), 'question', REG.clientId, false)), '503 ASK_REMOTE_NOT_ADMITTED', 'second submit');
  assert.ok(s.state.integrityStopped && s.state.counters.duplicateSubmit === 1 && s.state.counters.claimed === 1);
  // The integrity stop is sticky for this server process: even a new pair and READY arm is never admitted again.
  s.state.endPair(s.state.pair!.pairId);
  s.state.finishArm(r.armId);
  const again = ready(s, 'FX02');
  assert.equal(verdict(s.gate.admit(good(again.session), 'question', REG.clientId, false)), '503 ASK_REMOTE_NOT_ADMITTED');
});

test('claimed task: registered scope after authentication (403, counted), focus equality (400), exact request capture, receipt at write time', () => {
  const s = setup(); const r = ready(s, 'FX05');
  const a = s.gate.admit(good(r.session), 'question', REG.clientId, false); assert.equal(a.kind, 'claimed');
  const task = (a as { exchange: RegisteredTask }).exchange;
  assert.throws(() => task.ask.authenticated({ workspaceId: REG.workspaceId, actorId: 'other-actor' }, REG.clientId, randomUUID()), { code: 'ASK_SCOPE_DENIED' });
  assert.equal(s.state.counters.scopeDenied, 1);
  assert.equal(task.binding, null, 'no Binding, no observation for a foreign identity');
  const correlationId = randomUUID();
  task.ask.authenticated({ workspaceId: REG.workspaceId, actorId: REG.actorId }, REG.clientId, correlationId);
  const bound = (task as { binding: { correlationId: string; armId: string; handoffConnectionId: string } | null }).binding;
  assert.ok(bound && bound.correlationId === correlationId && bound.armId === r.armId && bound.handoffConnectionId === r.handoff);
  assert.equal(s.observer.read(r.armId)?.revision, 1);
  const wrong = askRequest(undefined, null);
  assert.throws(() => task.ask.request(wrong as never, wrong), { code: 'ASK_REQUEST_INVALID' });
  const req = askRequest(undefined, 'obs-synthetic-5');
  task.ask.request({ observationId: req.observationId } as never, req);
  assert.deepEqual(s.state.slot!.request, req, 'the exact wire body, not a normalized form');
  (req as { question: string }).question = 'edited after capture';
  assert.notEqual((s.state.slot!.request as { question: string }).question, 'edited after capture', 'a copy is captured');
  assert.deepEqual(task.publishing(200, '{"a":1}', randomUUID()), {}, 'another correlation never binds');
  const headers = task.publishing(200, '{"contractVersion":"AskAnswerV2"}', correlationId);
  assert.ok(typeof headers[RECEIPT_HEADER] === 'string' && s.state.slot?.state === 'AVAILABLE' && s.state.slot.receiptNonce === headers[RECEIPT_HEADER]);
  assert.equal(s.observer.read(r.armId)?.publication.state, 'PENDING');
  task.finished(); task.released();
  const fin = s.observer.read(r.armId)!;
  assert.deepEqual([fin.publication, fin.final, s.state.arm?.state], [{ state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null }, true, 'DONE']);
});

test('claimed task without a captured request (V2 failure) burns the slot at write time: no receipt, the ERROR publication is still observed', () => {
  const s = setup(); const r = ready(s);
  const task = (s.gate.admit(good(r.session), 'question', REG.clientId, false) as { exchange: RegisteredTask }).exchange;
  const correlationId = randomUUID();
  task.ask.authenticated({ workspaceId: REG.workspaceId, actorId: REG.actorId }, REG.clientId, correlationId);
  assert.deepEqual(task.publishing(400, '{"code":"ASK_REQUEST_INVALID"}', correlationId), {});
  assert.equal(s.state.slot?.state, 'BURNED');
  task.finished(); task.released();
  assert.deepEqual(s.observer.read(r.armId)?.publication, { state: 'SERVER_FINISHED', kind: 'ERROR', status: 400, code: 'ASK_REQUEST_INVALID' });
  // An aborted write is FAILED, never SERVER_FINISHED.
  const s2 = setup(); const r2 = ready(s2);
  const t2 = (s2.gate.admit(good(r2.session), 'question', REG.clientId, false) as { exchange: RegisteredTask }).exchange;
  t2.ask.authenticated({ workspaceId: REG.workspaceId, actorId: REG.actorId }, REG.clientId, randomUUID());
  t2.aborted(); t2.released();
  assert.deepEqual([s2.observer.read(r2.armId)?.publication.state, s2.observer.read(r2.armId)?.final], ['FAILED', true]);
});

test('rc2 F5: a slot burned while the claimed task waited (revocation) never takes its Binding, request or a receipt; the observation continues', () => {
  const s = setup(); const r = ready(s);
  const task = (s.gate.admit(good(r.session), 'question', REG.clientId, false) as { exchange: RegisteredTask }).exchange;
  s.state.endPair(s.state.pair!.pairId); // END_PAIR while the task is still authenticating
  const correlationId = randomUUID();
  task.ask.authenticated({ workspaceId: REG.workspaceId, actorId: REG.actorId }, REG.clientId, correlationId);
  const req = askRequest(undefined, null);
  task.ask.request({ observationId: null } as never, req);
  assert.deepEqual(task.publishing(200, '{"contractVersion":"AskAnswerV2"}', correlationId), {}, 'no receipt');
  assert.equal(s.state.rawRetained(), false, 'no raw value entered the burned slot');
  assert.equal(s.observer.read(r.armId)?.publication.state, 'PENDING', 'the safe observation still records the publication');
});

test('RS-D-A census: a claimed task that never reaches a Binding is unattributed at release; a bound one is not; reservations are counted only when bound', () => {
  const s = setup(); const r = ready(s);
  const claimed = s.gate.admit(good(r.session), 'question', REG.clientId, false);
  assert.equal(claimed.kind, 'claimed');
  if (claimed.kind !== 'claimed') return;
  claimed.exchange.ask.reservation('COMMITTED', randomUUID()); // before authentication: no Binding, nothing counted
  claimed.exchange.released();
  let c = s.census.snapshot();
  assert.deepEqual([c.submitIngressCount, c.unattributedCount, c.reservationConfirmedCount], ['1', '1', '0']);
  const t = setup(); const b = ready(t); t.census.attachOwners({ active: 1, releases: 0 }); // the bound task's one physical owner
  const bound = t.gate.admit(good(b.session), 'question', REG.clientId, false);
  if (bound.kind !== 'claimed') { assert.fail('claim'); return; }
  bound.exchange.ask.authenticated({ workspaceId: REG.workspaceId, actorId: REG.actorId } as never, REG.clientId, randomUUID());
  bound.exchange.ask.reservation('COMMITTED', randomUUID());
  // The census-wrapped transport seam entered while this arm is CLAIMED: consumed and dispatched, so never the no-dispatch proof.
  const seams = t.census.wrapSeams({ resolveSecret: () => null, transport: () => ({ result: Promise.resolve({ kind: 'ERROR' }), settled: Promise.resolve() }) as never });
  seams.transport(Buffer.from(''), 'k', new AbortController().signal);
  bound.exchange.ask.settlement('CONFIRMED');
  const item = t.census.snapshot().tasks.find(x => x.correlationId !== null)!;
  assert.deepEqual([item.capabilityConsumed, item.transportEntered, item.noDispatchProof, t.census.snapshot().coverage], [true, true, 'UNAVAILABLE', 'COMPLETE']);
  bound.exchange.released();
  c = t.census.snapshot();
  assert.deepEqual([c.unattributedCount, c.reservationConfirmedCount, c.capabilityConsumedCount, c.transportEntryCount], ['0', '1', '1', '1']);
});
