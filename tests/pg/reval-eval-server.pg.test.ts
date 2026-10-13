import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeTransfer } from '../../packages/reval/eval-transient.ts';
import { decodePair200 } from '../../packages/reval/eval-handoff-dto.ts';
import { decodeTerminalObservation, newToken } from '../../packages/reval/eval-wire.ts';
import { dataset, ownerTx, WS } from '../support/reval-fixture-pg.ts';
import { envelope, KEY, response } from '../support/ask-remote-api.ts';
import { policyRow, revise } from '../support/ask-remote-pg.ts';
import { answerResult } from '../support/reval-eval-fixtures.ts';
import { askPath, browserHeaders, evalSandbox, handoffPath, HandoffClient, pairAndArm, pairOnly, post, question, respond, startEvalServer }
  from '../support/reval-eval-server.ts';
import type { EvalServer } from '../support/reval-eval-server.ts';

// R-EVAL RS-C-A bridge server on Docker PG17 (rs-c/IMPLEMENTATION_BRIEF.md §1–§5): the BUILT production composition over the
// registered RS-B sandbox (FX02 installed by the maintenance code, policy ACTIVE) with the scripted OFFLINE provider. The test
// plays C (restricted hub operations), I (handoff socket) and the browser (raw HTTP). Covered: the whole pair → arm → READY →
// question → RESPONSE → TRANSFER/ACK/COMMIT → terminal observation path; D6 clock isolation; the ingress matrix before body/
// bearer/DB; the one-claim race; terminal faults latched before settlement; a generation change between ARM and phase1.
const sb = await evalSandbox();
const owner = sb.ns.db.owner;
const servers: EvalServer[] = [];
// Servers (and their handoff sockets/runtime connections) close BEFORE the throwaway database is dropped.
after(async () => { for (const s of servers) await s.close().catch(() => undefined); await sb.ns.cleanup(); });
const server = async () => { const s = await startEvalServer(sb); servers.push(s); return s; };
const attempts = () => ownerTx(owner, async () => (await owner.query(`SELECT id::text, state, outcome, "dayStart"::text AS day FROM "RemoteAskAttempt"
  WHERE "workspaceId" = $1 ORDER BY "createdAt"`, [WS])).rows as { id: string; state: string; outcome: string | null; day: string }[]);
const today = () => new Date().toISOString().slice(0, 10);
const securityAudits = () => ownerTx(owner, async () => Number((await owner.query(`SELECT count(*)::int AS n FROM "SecurityAuditEvent" WHERE "workspaceId" = $1`, [WS])).rows[0].n));
/** The task's record once FINAL (physical release + terminal publication); the settlement/pause work ends before the release. */
async function finalObservation(srv: EvalServer, armId: string): Promise<unknown> {
  for (let i = 0; i < 200; i += 1) { const o = srv.runtime.terminal(armId); if (typeof o !== 'string' && o.final) return o; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('observation never became final');
}

test('one case end to end: PAIR200 focus, ARM, READY, 200 + receipt, RESPONSE → TRANSFER/ACK/COMMIT → 204; final collected observation; D6 clock isolation', async () => {
  const srv = await server(); const before = (await attempts()).length;
  const a = await pairAndArm(srv, sb);
  assert.deepEqual(decodePair200(a.pair200).evaluationFocus, { registrationId: sb.r.registrationId, fixtureId: 'FX02', fixtureGeneration: '1',
    requestedFocus: 'syn-obs-b2', focusState: 'FOUND', syntheticFreshnessAt: '2026-10-10T07:30:00.000Z' });
  const q = await question(srv, sb, a);
  assert.equal(q.res.status, 200, q.res.body);
  const receipt = q.res.headers['x-atlas-evaluation-receipt'];
  assert.ok(typeof receipt === 'string' && receipt.length === 43);
  assert.equal(srv.scripted.captures.length, 1); assert.equal(srv.scripted.captures[0]!.key, KEY);
  const answer = JSON.parse(q.res.body);
  // D6: the pinned reference decides resource freshness ONLY; the answer time and the ledger day are real time.
  const resources = Object.fromEntries(answer.evidence.filter((f: any) => f.kind === 'RESOURCE_STATE')
    .map((f: any) => [`R:${f.data.source}/${f.data.resourceType}/${f.data.connectionId}`, f.data.status]));
  assert.deepEqual(resources, dataset.byId.get('FX02')!.expected.resourceStatus);
  assert.ok(Math.abs(Date.parse(answer.generatedAt) - Date.now()) < 60_000, 'generatedAt is the real clock');
  const rows = (await attempts()).slice(before);
  assert.deepEqual(rows.map(r => [r.day, r.outcome]), [[today(), 'USAGE_VERIFIED']], 'one settled attempt on the real UTC day');
  // RESPONSE: the server compares and transfers; I validates and ACKs; S COMMITs; the browser gets 204 after the COMMIT.
  const handoff = respond(srv, sb, a, q);
  const transfer = decodeTransfer(await a.ho.next());
  assert.deepEqual(transfer.request, q.body); assert.equal(transfer.response.status, 200);
  assert.deepEqual(transfer.response.body, answer); assert.equal(transfer.binding.armId, a.arm.armId); assert.equal(transfer.readySequence, a.readySequence);
  a.ho.send({ contractVersion: 'RevalTransientAckV1', challenge: transfer.ackChallenge, transferSequence: transfer.sequence, transferId: transfer.transferId,
    binding: transfer.binding, commitChallenge: randomUUID(), disposition: 'ACCEPTED', result: answerResult, failureCode: null });
  const commit = await a.ho.next();
  assert.deepEqual([commit.contractVersion, commit.disposition, commit.transferId], ['RevalTransientCommitV1', 'COMMITTED', transfer.transferId]);
  const h = await handoff;
  assert.equal(h.status, 204); assert.equal(h.headers['cache-control'], 'no-store');
  const replay = await respond(srv, sb, a, q);
  assert.deepEqual([replay.status, JSON.parse(replay.body).code], [503, 'RAW_EXPIRED'], 'the receipt is one-use');
  // Terminal observation (S records; C would journal): final, settled, published, released.
  const obs = decodeTerminalObservation(await finalObservation(srv, a.arm.armId));
  assert.deepEqual([obs.final, obs.physicalOwnerReleased, obs.reservation, obs.settlement, obs.attemptId, obs.publication],
    [true, true, 'COMMITTED', 'CONFIRMED', rows[0]!.id, { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null }]);
  assert.equal(obs.binding.correlationId, q.res.headers['x-atlas-correlation-id']);
  assert.ok(srv.runtime.collected(a.arm.armId, obs.observationId, obs.revision) && srv.runtime.observer.priorCollected());
  assert.ok(!JSON.stringify(obs).includes(q.body.question) && !JSON.stringify(obs).includes(String(receipt)), 'no raw value in the observation');
  a.ho.channel.close();
});

test('ingress before body/bearer/DB: registered POST without/invalid header, capability/foreign-scope header, pre-GO, OFF paths', async () => {
  const srv = await server(); const before = (await attempts()).length;
  const h = (extra: Record<string, string>, bearer = 'not-a-token-at-all-xxxxxxxx') => browserHeaders(srv.port, bearer, extra, 300);
  const code = (r: { status: number; body: string }) => `${r.status} ${r.body ? JSON.parse(r.body).code ?? JSON.parse(r.body).statusCode : ''}`;
  // Headers only, the declared 300-byte body is NEVER sent: an answer proves nothing was read; an invalid bearer proves no authentication ran.
  assert.equal(code(await post(srv.port, askPath, null, h({}))), '503 ASK_REMOTE_NOT_ADMITTED');
  assert.equal(code(await post(srv.port, askPath, null, h({ 'x-atlas-evaluation-session': 'short' }))), '400 ASK_REQUEST_INVALID');
  assert.equal(code(await post(srv.port, askPath, null, h({ 'x-atlas-evaluation-session': newToken() }))), '503 ASK_REMOTE_NOT_ADMITTED', 'pre-GO / unknown token');
  assert.equal(code(await post(srv.port, askPath, null, h({ 'x-atlas-evaluation-session': newToken(), origin: 'http://127.0.0.1:1' }))), '400 ASK_REQUEST_INVALID');
  assert.equal(code(await post(srv.port, '/clients/other-client/ask', null, h({ 'x-atlas-evaluation-session': newToken() }))), '400 ASK_REQUEST_INVALID');
  assert.equal(code(await post(srv.port, '/ask/capabilities', null, { host: `127.0.0.1:${srv.port}`, 'x-atlas-evaluation-session': newToken() }, 'GET')), '400 ASK_REQUEST_INVALID');
  assert.equal((await post(srv.port, '/ask/capabilities', null, { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${sb.tokens.actor}` }, 'GET')).status, 200);
  // Paired, no arm yet: the CURRENT session token is still pre-GO (503 before the body).
  const p = await pairOnly(srv, sb);
  assert.equal(code(await post(srv.port, askPath, null, h({ 'x-atlas-evaluation-session': p.sessionToken }))), '503 ASK_REMOTE_NOT_ADMITTED');
  p.ho.channel.close();
  assert.equal((await post(srv.port, handoffPath, null, { host: `127.0.0.1:${srv.port}` }, 'GET')).status, 404, 'GET handoff');
  assert.equal((await post(srv.port, '/clients/other-client/ask/evaluation-handoff', '{}', browserHeaders(srv.port, sb.tokens.actor))).status, 404);
  const noOrigin = { ...browserHeaders(srv.port, sb.tokens.actor) }; delete noOrigin.origin;
  assert.equal(code(await post(srv.port, handoffPath, '{}', noOrigin)), '400 PROTOCOL_INVALID');
  const pair = JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: newToken() });
  const noBearer = { ...browserHeaders(srv.port, sb.tokens.actor) }; delete noBearer.authorization;
  assert.equal(code(await post(srv.port, handoffPath, pair, noBearer)), '401 UNAUTHORIZED');
  assert.equal((await attempts()).length, before, 'no attempt row from any rejected request');
  assert.equal(srv.scripted.captures.length, 0);
  assert.ok(srv.runtime.state.counters.rejectedUnpairedCount >= 4);
  // rc2 F11: the evaluation header on any other route of the measured server is a fixed 400, never silently ignored.
  const other = await post(srv.port, '/clients', null, { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${sb.tokens.actor}`,
    'x-atlas-evaluation-session': newToken() }, 'GET');
  assert.deepEqual([other.status, JSON.parse(other.body).code], [400, 'ASK_REQUEST_INVALID']);
  assert.notEqual((await post(srv.port, '/clients', null, { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${sb.tokens.actor}` }, 'GET')).status, 400,
    'without the header the route is unchanged');
});

test('rc2 F1: the bridge seams never resolve a key — an env:// policy whose key IS in process.env stays NO_DISPATCH (the ordinary resolver would resolve it)', async () => {
  const name = 'ATLAS_ASK_REMOTE_REVAL_PROBE';
  process.env[name] = `synthetic-probe-${'x'.repeat(32)}`;
  const { productionSeams } = await import(new URL('../../dist/packages/ask/remote/secret.js', import.meta.url).href);
  assert.notEqual(productionSeams().resolveSecret(`env://${name}`), null, 'control: the ordinary production resolver reads process.env');
  sb.policyVersion = await revise(owner, WS, { secretRef: `env://${name}` });
  try {
    const srv = await startEvalServer(sb, { bridgeSeams: true }); servers.push(srv);
    const before = (await attempts()).length;
    const a = await pairAndArm(srv, sb);
    const q = await question(srv, sb, a);
    assert.deepEqual([q.res.status, JSON.parse(q.res.body).code], [503, 'ASK_REMOTE_UNAVAILABLE'], q.res.body);
    assert.deepEqual((await attempts()).slice(before).map(r => r.outcome), ['NO_DISPATCH']);
    a.ho.channel.close();
  } finally {
    delete process.env[name];
    sb.policyVersion = await revise(owner, WS, { secretRef: 'fixture://ask-remote/synthetic-key-ref' });
  }
});

test('stolen session token + foreign bearer → 403 before phase1 (arm consumed, no attempt); focus mismatch → 400; neither reaches the provider', async () => {
  const srv = await server(); const before = (await attempts()).length; const audits = await securityAudits();
  const a = await pairAndArm(srv, sb);
  const stolen = await question(srv, sb, a, { bearer: sb.tokens.other });
  assert.deepEqual([stolen.res.status, JSON.parse(stolen.res.body).code], [403, 'ASK_SCOPE_DENIED']);
  assert.equal(srv.runtime.state.counters.scopeDenied, 1);
  assert.equal(srv.runtime.observer.read(a.arm.armId), null, 'no observation for a foreign identity');
  // NB10 (rc2): the post-authentication registration mismatch is guard-count-only — no workspace security audit row is written.
  assert.equal(await securityAudits(), audits, 'guard-count-only: no SecurityAuditEvent');
  const late = await question(srv, sb, a);
  assert.deepEqual([late.res.status, JSON.parse(late.res.body).code], [503, 'ASK_REMOTE_NOT_ADMITTED'], 'the arm was consumed');
  const srv2 = await server(); const b = await pairAndArm(srv2, sb);
  const focus = await question(srv2, sb, b, { observationId: 'syn-obs-b1' });
  assert.deepEqual([focus.res.status, JSON.parse(focus.res.body).code], [400, 'ASK_REQUEST_INVALID']);
  assert.equal(focus.res.headers['x-atlas-evaluation-receipt'], undefined, 'no receipt without an exact captured request');
  assert.equal((await attempts()).length, before); assert.equal(srv.scripted.captures.length + srv2.scripted.captures.length, 0);
  a.ho.channel.close(); b.ho.channel.close();
});

test('one-claim race: two concurrent submits with the session token → exactly one 200, one 503, one provider call, integrity stop', async () => {
  const srv = await server(); const a = await pairAndArm(srv, sb);
  srv.scripted.next = async () => { await new Promise(r => setTimeout(r, 150)); return response(envelope()); };
  const [x, y] = await Promise.all([question(srv, sb, a), question(srv, sb, a)]);
  assert.deepEqual([x.res.status, y.res.status].sort(), [200, 503]);
  assert.equal(srv.scripted.captures.length, 1);
  assert.ok(srv.runtime.state.integrityStopped && srv.runtime.state.counters.claimed === 1 && srv.runtime.state.counters.duplicateSubmit === 1);
  a.ho.channel.close();
});

test('terminal fault is latched before settlement (MODEL mismatch): fault then settlement in that order; ERROR publication observed', async () => {
  const srv = await server(); const a = await pairAndArm(srv, sb);
  srv.scripted.next = () => response(envelope('SUMMARY', e => { e.model = 'gpt-other-model'; }));
  const order: string[] = [];
  const o = srv.runtime.observer; const fault = o.fault.bind(o); const settle = o.settlement.bind(o);
  o.fault = (armId: string, f: string) => { order.push(`fault:${f}`); fault(armId, f); };
  o.settlement = (armId: string, s: string) => { order.push(`settlement:${s}`); settle(armId, s); };
  const q = await question(srv, sb, a);
  assert.deepEqual([q.res.status, JSON.parse(q.res.body).code], [503, 'ASK_REMOTE_MODEL_MISMATCH']);
  assert.equal(order[0], 'fault:MODEL_OR_TIER_MISMATCH'); assert.ok(order[1]?.startsWith('settlement:'), order.join(','));
  const obs = decodeTerminalObservation(await finalObservation(srv, a.arm.armId));
  assert.equal(obs.detectedFault, 'MODEL_OR_TIER_MISMATCH'); assert.ok(obs.detectedAt !== null && obs.settlement !== 'NOT_ATTEMPTED');
  assert.deepEqual(obs.publication, { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_MODEL_MISMATCH' });
  // The accepted R-B protective pause applies unchanged; the owner re-activates for the following cases.
  assert.equal((await policyRow(owner, WS))!.state, 'PAUSED');
  sb.policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
  a.ho.channel.close();
});

test('a fixture generation that differs from the arm at phase1 → 409 ASK_SCOPE_CHANGED, no attempt, no provider call', async () => {
  const srv = await server(); const before = (await attempts()).length;
  const a = await pairAndArm(srv, sb);
  // Simulates a generation switch between ARM and phase1 (a real switch needs every other backend gone — impossible while S runs).
  srv.runtime.state.arm.ack.fixtureGeneration = '2';
  const q = await question(srv, sb, a);
  assert.deepEqual([q.res.status, JSON.parse(q.res.body).code], [409, 'ASK_SCOPE_CHANGED']);
  assert.equal((await attempts()).length, before); assert.equal(srv.scripted.captures.length, 0);
  a.ho.channel.close();
});

test('the handoff socket refuses a peer without a TTY: no WELCOME, the connection closes', async () => {
  const srv = await startEvalServer(sb, { peer: { hasTty: false } }); servers.push(srv);
  await assert.rejects(HandoffClient.open(srv.handoffPath));
});
