import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ACK_WAIT_EXPIRED, EvaluationRuntime } from '../packages/reval/eval-runtime.ts';
import type { HandoffLink } from '../packages/reval/eval-runtime.ts';
import { SLOT_MS } from '../packages/reval/eval-state.ts';
import { newToken } from '../packages/reval/eval-wire.ts';
import { answerResult, binding, TestClock } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A RESPONSE transfer at the hub (06 "Exact transient transfer"; rc2 review F3/F4) with an injected clock and a fake
// measured handoff link: the deadline is checked before the nonce claim and before TRANSFER; TRANSFER echoes the slot's OWN READY;
// an ACK accepted after the slot's 120 s raw expiry or after the 2 s deadline gets COMMIT FAILED (never COMMITTED). Pure.
const REG = { registrationId: randomUUID(), databaseInstanceId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor-reval',
  admissionId: randomUUID() };
class FakeLink implements HandoffLink {
  readonly connectionId = randomUUID(); readonly controlConnectionId = randomUUID();
  readonly sent: Record<string, unknown>[] = []; #seq = 0n;
  ack: (deadline: number) => Promise<unknown | null> = async () => null;
  send(build: (sequence: string) => Record<string, unknown>): string { this.#seq += 1n; const s = String(this.#seq); this.sent.push(build(s)); return s; }
  nextAck(deadline: number): Promise<unknown | null> { return this.ack(deadline); }
  close(): void { /* fake */ }
}
/** A runtime with one READY arm claimed and its slot AVAILABLE (as after a published answer). */
function answered() {
  const clock = new TestClock();
  const rt = new EvaluationRuntime({ reg: REG, serverBootId: randomUUID(), port: 3999, db: {} as never, clock });
  const link = new FakeLink(); rt.connected(link);
  const pairId = randomUUID(); const nonce = newToken();
  assert.ok(typeof rt.installPair({ contractVersion: 'RevalPairSecretV1', registrationId: REG.registrationId, serverBootId: rt.serverBootId, connectionId: randomUUID(),
    sequence: '3', challenge: randomUUID(), requestSequence: '3', pairId, instrumentControlConnectionId: link.controlConnectionId,
    instrumentHandoffConnectionId: link.connectionId, pairingNonce: nonce, expiresAt: new Date(clock.wall() + 60_000).toISOString() }) !== 'string');
  const p = rt.state.browserPair(nonce, { credential: 'c'.repeat(64), admissionId: REG.admissionId, policyVersion: '3', fixtureGeneration: '1',
    admissionExpiresMs: clock.wall() + 86_400_000, credentialExpiresMs: null });
  assert.ok(typeof p !== 'string');
  rt.state.seeCase('case-a');
  const arm = rt.state.armCase({ caseId: 'case-a', fixtureId: 'FX02', fixtureGeneration: '1', admissionId: REG.admissionId, policyVersion: '3', preSnapshotId: randomUUID(),
    browserPairId: pairId }, { fixtureId: 'FX02', fixtureGeneration: '1', admissionId: REG.admissionId, policyVersion: '3', policyActive: true,
    admissionExpiresMs: clock.wall() + 86_400_000, priorCollected: true });
  assert.ok(typeof arm !== 'string');
  const readyChallenge = randomUUID();
  assert.equal(rt.state.ready(link.connectionId, arm.armId, '5', readyChallenge), null);
  assert.ok(rt.state.claim(p.sessionToken));
  const correlationId = randomUUID(); const request = { contractVersion: 'AskRequestV2', q: 1 }; const body = { contractVersion: 'AskAnswerV2', a: 1 };
  const slot = rt.state.slot!;
  slot.binding = binding({ armId: arm.armId, pairId, handoffConnectionId: link.connectionId, correlationId });
  slot.request = request; slot.publication = { status: 200, correlationId, body }; slot.receiptNonce = newToken(); slot.state = 'AVAILABLE';
  const respond = (deadline: number, over: { request?: unknown } = {}) => rt.respond(pairId, slot.receiptNonce!, over.request ?? request, { status: 200, correlationId, body }, deadline);
  const ackFor = (t: Record<string, unknown>) => ({ contractVersion: 'RevalTransientAckV1', connectionId: link.connectionId, sequence: '2', challenge: t.ackChallenge,
    transferSequence: t.sequence, transferId: t.transferId, binding: t.binding, commitChallenge: randomUUID(), disposition: 'ACCEPTED', result: answerResult, failureCode: null });
  return { clock, rt, link, slot, respond, ackFor, readyChallenge };
}

test('a deadline already passed refuses BEFORE the nonce claim (the slot stays AVAILABLE) and nothing is transferred', async () => {
  const x = answered();
  assert.equal(await x.respond(x.clock.mono()), 'DEADLINE');
  assert.equal(x.slot.state, 'AVAILABLE'); assert.equal(x.link.sent.length, 0);
});

test('TRANSFER echoes the slot\'s OWN READY; a valid ACK inside the deadline and raw bound COMMITs', async () => {
  const x = answered();
  x.link.ack = async () => x.ackFor(x.link.sent[0]!);
  assert.equal(await x.respond(x.clock.mono() + 2000), null);
  const [t, c] = x.link.sent;
  assert.deepEqual([t!.contractVersion, t!.challenge, t!.readySequence], ['RevalTransientTransferV1', x.readyChallenge, '5']);
  assert.deepEqual([c!.contractVersion, c!.disposition], ['RevalTransientCommitV1', 'COMMITTED']);
  assert.equal(x.slot.state, 'COMMITTED'); assert.equal(x.rt.state.rawRetained(), false);
});

test('rc2 F4: an ACK accepted after the 120 s raw expiry gets COMMIT FAILED RAW_EXPIRED; after the 2 s deadline COMMIT FAILED ACK_TIMEOUT', async () => {
  const x = answered();
  x.link.ack = async () => { x.clock.advance(SLOT_MS); return x.ackFor(x.link.sent[0]!); };
  assert.equal(await x.respond(x.clock.mono() + SLOT_MS + 10_000), 'RAW_EXPIRED');
  assert.deepEqual([x.link.sent[1]!.disposition, x.link.sent[1]!.failureCode], ['FAILED', 'RAW_EXPIRED']);
  assert.equal(x.slot.state, 'BURNED', 'never COMMITTED after its expiry'); assert.equal(x.rt.state.rawRetained(), false);
  const y = answered();
  const deadline = y.clock.mono() + 2000;
  y.link.ack = async () => { y.clock.advance(2000); return y.ackFor(y.link.sent[0]!); };
  assert.equal(await y.respond(deadline), 'DEADLINE');
  assert.deepEqual([y.link.sent[1]!.disposition, y.link.sent[1]!.failureCode], ['FAILED', 'ACK_TIMEOUT']);
  assert.equal(y.slot.state, 'BURNED');
});

test('RS-C-C (carried RS-C-A residual): the ACK timer firing before the monotonic clock reaches the deadline is still 504 DEADLINE, never IPC_LOST; a closed link is IPC_LOST', async () => {
  const x = answered(); const deadline = x.clock.mono() + 2000;
  x.link.ack = async () => ACK_WAIT_EXPIRED; // the timer fired while the clock still reads before the deadline (Node fires up to ~2 ms early)
  assert.equal(await x.respond(deadline), 'DEADLINE');
  assert.equal(x.slot.state, 'BURNED');
  const y = answered();
  y.link.ack = async () => null; // the channel closed before the deadline
  assert.equal(await y.respond(y.clock.mono() + 2000), 'IPC_LOST');
});

test('a mismatching RESPONSE burns the slot without TRANSFER; a burned slot answers RAW_EXPIRED', async () => {
  const x = answered();
  assert.equal(await x.respond(x.clock.mono() + 2000, { request: { contractVersion: 'AskRequestV2', q: 2 } }), 'CONTENT_MISMATCH');
  assert.equal(x.link.sent.length, 0); assert.equal(x.slot.state, 'BURNED');
  assert.equal(await x.respond(x.clock.mono() + 2000), 'RAW_EXPIRED');
});

test('rc2 F2/F12 (row S): a frozen case ID is marked seen BEFORE the DB read — a failed read never leaves it armable; unknown IDs are not admitted', async () => {
  const clock = new TestClock();
  const db = { $transaction: async () => { throw new Error('db down'); } } as never;
  const rt = new EvaluationRuntime({ reg: REG, serverBootId: randomUUID(), port: 3999, db, clock, cases: new Map([['case-a', 'FX02'], ['case-b', 'FX02']]) });
  const p = { fixtureId: 'FX02', fixtureGeneration: '1', admissionId: REG.admissionId, policyVersion: '3', preSnapshotId: randomUUID(), browserPairId: randomUUID() };
  assert.equal(await rt.armCase({ ...p, caseId: 'case-x' }), 'FIXTURE_MISMATCH', 'not a frozen case');
  assert.equal(rt.state.seeCase('case-x'), null, 'an unknown ID was never added to the seen set');
  assert.equal(await rt.armCase({ ...p, caseId: 'case-a' }), 'ARM_UNAVAILABLE', 'the fact read failed');
  assert.equal(await rt.armCase({ ...p, caseId: 'case-a' }), 'CASE_CONSUMED', 'the failed read already consumed it');
  assert.equal(await rt.armCase({ ...p, caseId: 'case-b', fixtureId: 'FX05' }), 'FIXTURE_MISMATCH');
  assert.equal(await rt.armCase({ ...p, caseId: 'case-b' }), 'CASE_CONSUMED');
});
