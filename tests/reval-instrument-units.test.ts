import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ledgerValues } from '../scripts/ask-remote-eval-execution/validate.ts';
import { bindCorpus } from '../scripts/ask-remote-eval-execution/corpus.ts';
import { FakeV2, fakeRequest } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { verifyRevision } from '../scripts/reval-instrument/identity.ts';
import { countersOf, ledgerOf } from '../scripts/reval-instrument/ledger.ts';
import { receiveTransfer, safeResultOf } from '../scripts/reval-instrument/transfer.ts';
import type { ReadySent } from '../scripts/reval-instrument/transfer.ts';
import { fakeSnapshot } from './support/reval-instrument-fixtures.ts';

// R-EVAL RS-C-B instrument revision units (rs-c brief B §3, §5): the controller-snapshot ledger/counters mapping onto the accepted RC5
// settlement vocabulary, and the 06 instrument side of the transfer (READY binding, accepted validators → SafeResult, PENDING before
// ACK, COMMITTED only on the matching COMMIT). Pure: a fake handoff port; the frozen corpus via the chained identity.
const ADMISSION = randomUUID();
const ctxOf = (() => { const c = bindCorpus(verifyRevision().snapshot); return (caseId: string) => {
  const frozen = c.corpus.cases.get(caseId)!; return { ctx: { frozen, fixture: c.corpus.fixtures.get(frozen.fixtureId)!, scope: c.corpus.scope }, corpus: c.corpus };
}; })();

test('ledger: accepted R-B attempts → RC5 settlements (each accepted by the unchanged RC5 ledger validator); counters of the current day/month', () => {
  const corr = randomUUID(); const caps = { day: 2_000_000, month: 10_000_000 };
  const cases: [Parameters<typeof fakeSnapshot>[0]['attempts'], string, string][] = [
    [[], 'NO_RESERVATION', '0'],
    [[{ correlationId: corr, state: 'SETTLED', outcome: 'USAGE_VERIFIED', accounted: '222' }], 'CONFIRMED', '222'],
    [[{ correlationId: corr, state: 'SETTLED', outcome: 'NO_DISPATCH', accounted: '0' }], 'NO_DISPATCH', '0'],
    [[{ correlationId: corr, state: 'UNKNOWN', outcome: 'MODEL_MISMATCH', accounted: '300000' }], 'RETAINED_KNOWN', '300000'],
    [[{ correlationId: corr, state: 'UNKNOWN', outcome: 'UPSTREAM_REJECTED', accounted: '300000' }], 'RETAINED_KNOWN', '300000'],
    [[{ correlationId: corr, state: 'UNKNOWN', outcome: 'DELIVERY_UNKNOWN', accounted: '300000' }], 'RETAINED_UNKNOWN_COMMIT', '300000'],
  ];
  for (const [attempts, settlement, charged] of cases) {
    const s = fakeSnapshot({ admissionId: ADMISSION, attempts: [...(attempts ?? []), { correlationId: randomUUID(), state: 'SETTLED', outcome: 'NO_DISPATCH', accounted: '0' }] });
    const l = ledgerOf(s, corr);
    assert.ok(l !== 'PENDING'); assert.deepEqual([l.settlement, l.chargedMicro], [settlement, charged]);
    assert.deepEqual([l.dayChargedMicro, l.monthChargedMicro], [countersOf(s).dayChargedMicro, countersOf(s).monthChargedMicro]);
    assert.equal(ledgerValues(l, caps).settlement, settlement, 'accepted by the RC5 validator');
  }
  const pending = fakeSnapshot({ admissionId: ADMISSION, attempts: [{ correlationId: corr, state: 'EGRESS_COMMITTED', outcome: null, accounted: '300000' }] });
  assert.equal(ledgerOf(pending, corr), 'PENDING');
  const unknown = ledgerOf(pending, corr, true);
  assert.ok(unknown !== 'PENDING' && unknown.settlement === 'RETAINED_UNKNOWN_COMMIT' && unknown.chargedMicro === '300000');
  const twice = ledgerOf(fakeSnapshot({ admissionId: ADMISSION, attempts: [{ correlationId: corr, state: 'SETTLED', outcome: 'NO_DISPATCH', accounted: '0' },
    { correlationId: corr, state: 'SETTLED', outcome: 'USAGE_VERIFIED', accounted: '100' }] }), corr);
  assert.ok(twice !== 'PENDING' && twice.attempts === '2' && twice.settlement === 'CONFIRMED', 'a duplicate dispatch keeps its count for the RC5 integrity rule');
});

/** A case answered by the accepted fake V2 (synthetic), its READY, and the S frames the fake handoff port will deliver. */
function transferSetup(o: { intent?: string; tamper?: boolean } = {}) {
  const { ctx, corpus } = ctxOf('RE-UNS-051');
  const fake = new FakeV2(corpus.fixtures, corpus.scope, { admissionId: ADMISSION, version: '3', fence: '7', dayCap: 2_000_000, monthCap: 10_000_000 });
  const tuple = fake.tuple;
  const requestText = fakeRequest('rscb', ctx.frozen.question, ctx.fixture.spec.requestedFocus, tuple);
  const reply = fake.ask(requestText, ctx.frozen.fixtureId, { kind: 'INTENT', intent: (o.intent ?? 'UNSUPPORTED') as never, ...(o.tamper ? { tamper: 'DROP_PROVENANCE' as const } : {}) }, Date.parse('2026-10-12T10:00:00Z'));
  assert.ok(reply.http !== 'TIMEOUT');
  const handoffConnectionId = randomUUID();
  const ready: ReadySent = { sequence: '1', challenge: randomUUID(), registrationId: randomUUID(), serverBootId: randomUUID(), pairId: randomUUID(), armId: randomUUID(),
    caseId: 'RE-UNS-051', fixtureId: ctx.frozen.fixtureId, fixtureGeneration: '1', admissionId: ADMISSION, policyVersion: '3', preSnapshotId: randomUUID() };
  const binding = { registrationId: ready.registrationId, serverBootId: ready.serverBootId, guardEpoch: randomUUID(), handoffConnectionId, pairId: ready.pairId, armId: ready.armId,
    taskId: randomUUID(), caseId: ready.caseId, fixtureId: ready.fixtureId, fixtureGeneration: '1', admissionId: ADMISSION, policyVersion: '3', preSnapshotId: ready.preSnapshotId,
    correlationId: reply.correlationId! };
  const transfer = { contractVersion: 'RevalTransientTransferV1', connectionId: handoffConnectionId, sequence: '2', challenge: ready.challenge, readySequence: '1',
    transferId: randomUUID(), ackChallenge: randomUUID(), binding, bindingResult: 'SERVER_VALUES_MATCHED', publicationAuthority: reply.http.status === 200 ? 'CONFIRMED' : 'NOT_APPLICABLE',
    handoffAuthority: 'CONFIRMED', request: JSON.parse(requestText), response: { status: reply.http.status, correlationId: reply.correlationId, body: JSON.parse(String(reply.http.body)) } };
  const sent: Record<string, unknown>[] = []; const inbox: (Record<string, unknown> | 'TIMEOUT')[] = [transfer];
  const port = { connectionId: handoffConnectionId,
    send: (f: Record<string, unknown>) => { sent.push(f); return String(sent.length + 1); },
    next: async () => { const x = inbox.shift(); if (!x || x === 'TIMEOUT') throw Object.assign(new Error('t'), { code: 'IPC_TIMEOUT' }); return x; } };
  const commit = (over: Record<string, unknown> = {}) => ({ contractVersion: 'RevalTransientCommitV1', connectionId: handoffConnectionId, sequence: '3',
    challenge: sent[0]!.commitChallenge, ackSequence: '2', transferId: transfer.transferId, binding, disposition: 'COMMITTED', failureCode: null, ...over });
  return { ctx, tuple, ready, transfer, port, sent, inbox, commit };
}

test('transfer: PENDING saved BEFORE the ACK, SafeResult from the accepted validators, COMMITTED only on the matching COMMIT', async () => {
  const x = transferSetup();
  const order: string[] = []; let arrived = 0;
  const persisted: string[] = [];
  x.port.send = (f: Record<string, unknown>) => { order.push('ACK'); x.sent.push(f); x.inbox.push(x.commit()); return '2'; };
  const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, s => { order.push(`SAVE_${s.state}`); persisted.push(s.state); return true; },
    () => performance.now(), () => { arrived += 1; });
  assert.equal(r.state, 'COMMITTED');
  assert.deepEqual(order, ['SAVE_PENDING', 'ACK', 'SAVE_COMMITTED']); assert.equal(arrived, 1);
  const ack = x.sent[0]!;
  assert.deepEqual([ack.disposition, ack.failureCode, ack.challenge, ack.transferSequence], ['ACCEPTED', null, x.transfer.ackChallenge, '2']);
  assert.deepEqual(ack.result, { requestMatchesFrozen: true, semantic: 'MATCH', schema: true, claims: true, coverage: true, urgency: true, publicOutcome: 'ANSWER', publicErrorCode: null });
  assert.ok(!JSON.stringify(r.summary).includes(x.ctx.frozen.question), 'no raw value in the summary');
  assert.deepEqual(r.state === 'COMMITTED' && r.values.request, x.transfer.request, 'the exact values stay in memory for the outcome');
});

test('transfer refusals: a Binding that differs from the READY → REJECTED WRONG_BINDING (nothing saved); a foreign READY echo → no ACK; a failed save → REJECTED', async () => {
  { const x = transferSetup(); (x.transfer.binding as Record<string, string>).armId = randomUUID(); let saved = 0;
    // S answers the REJECTED ACK with COMMIT(FAILED): rc2 F3 — it is read inside the same window, never left for a later frame.
    x.port.send = (f: Record<string, unknown>) => { x.sent.push(f); x.inbox.push(x.commit({ disposition: 'FAILED', failureCode: 'ACK_INVALID' })); return '2'; };
    const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, () => { saved += 1; return true; });
    assert.deepEqual([r.state, r.state === 'UNVERIFIED' && r.code, saved, x.sent[0]?.disposition, x.sent[0]?.failureCode], ['UNVERIFIED', 'WRONG_BINDING', 0, 'REJECTED', 'WRONG_BINDING']);
    assert.equal(x.inbox.length, 0, 'the COMMIT(FAILED) was drained'); }
  { const x = transferSetup(); (x.transfer as Record<string, unknown>).challenge = randomUUID();
    const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, () => true);
    assert.deepEqual([r.state === 'UNVERIFIED' && r.code, x.sent.length], ['PROTOCOL_INVALID', 0], 'a frame answering another READY is never acknowledged'); }
  { const x = transferSetup();
    const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, () => false);
    assert.deepEqual([r.state === 'UNVERIFIED' && r.code, x.sent[0]?.disposition, x.sent[0]?.failureCode], ['METADATA_PERSIST_FAILED', 'REJECTED', 'METADATA_PERSIST_FAILED']); }
  { const x = transferSetup({ tamper: true });
    const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, () => true);
    assert.deepEqual([r.state === 'UNVERIFIED' && r.code, x.sent[0]?.failureCode], ['VALUE_VALIDATION_FAILED', 'VALUE_VALIDATION_FAILED'], 'no SafeResult for an invalid answer'); }
});

test('transfer: COMMIT FAILED, a forged or oversized (>4 KiB) COMMIT or none within 2 s → UNVERIFIED (summary saved UNVERIFIED with the code); a semantic MISMATCH is still a valid SafeResult', async () => {
  for (const [over, code] of [[{ disposition: 'FAILED', failureCode: 'RAW_EXPIRED' }, 'RAW_EXPIRED'], [{ challenge: randomUUID() }, 'PROTOCOL_INVALID'], ['TIMEOUT', 'ACK_TIMEOUT'],
    [{ padding: 'x'.repeat(5000) }, 'FRAME_TOO_LARGE']] as const) {
    const x = transferSetup(); const states: string[] = [];
    x.port.send = (f: Record<string, unknown>) => { x.sent.push(f); x.inbox.push(over === 'TIMEOUT' ? 'TIMEOUT' : x.commit(over)); return '2'; };
    const r = await receiveTransfer(x.port, x.ready, x.ctx, x.tuple, performance.now() + 5000, s => { states.push(s.state); return true; });
    assert.deepEqual([r.state === 'UNVERIFIED' && r.code, states], [code, ['PENDING', 'UNVERIFIED']]);
  }
  const m = transferSetup({ intent: 'SUMMARY' });
  assert.equal(safeResultOf(m.transfer as never, m.ctx, m.tuple)?.semantic, 'MISMATCH');
  const req = { ...(m.transfer.request as Record<string, unknown>), question: 'A different question entirely, typed by mistake?' };
  assert.deepEqual(safeResultOf({ request: req, response: m.transfer.response } as never, m.ctx, m.tuple)?.semantic, 'NOT_EVALUATED', 'a deviating request is never semantically credited');
});
