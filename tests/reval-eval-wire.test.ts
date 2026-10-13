import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeEvaluationFocus, decodeHandoffRequest, decodePair200, handoffErrorBody, handoffStatus } from '../packages/reval/eval-handoff-dto.ts';
import { decodeAck, decodeCommit, decodeHandoffSummary, decodeReady, decodeReadyAck, decodeSafeResult, decodeTransfer, decodeWireResponse }
  from '../packages/reval/eval-transient.ts';
import { decodeArmAck, decodeBinding, decodeHandoffHello, decodeHandoffWelcome, decodeInstrumentHello, decodeInstrumentWelcome, decodeObservationAck,
  decodePairAck, decodePairSecret, decodeServerLaunchV2, decodeTerminalObservation, isToken, newToken, PUBLIC_ERROR_STATUS } from '../packages/reval/eval-wire.ts';
import { answerResult, askRequest, binding, errorResult, rejects, terminal } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A exact schemas (rs-c/IMPLEMENTATION_BRIEF.md §5 "exact schemas of every new contractVersion"): every object is
// closed (extra/missing keys fail), every scalar is validated, and the cross-field rules hold. Pure; no process or database.
const u = () => randomUUID();
const extraKey = (o: object) => ({ ...o, extra: 1 });
const without = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

test('Token: 256-bit canonical 43-character base64url only', () => {
  const t = newToken();
  assert.ok(isToken(t) && t.length === 43);
  assert.ok(!isToken(t.slice(1)) && !isToken(`${t}A`) && !isToken(t.replace(/^./, '+')) && !isToken(null) && !isToken(u()));
  // A non-canonical last character (non-zero padding bits) decodes to the same bytes but is not the canonical text.
  const last = 'AQgw'.split('').find(c => !t.endsWith(c) && Buffer.from(t.slice(0, 42) + c, 'base64url').toString('base64url') !== t.slice(0, 42) + c);
  if (last) assert.ok(!isToken(t.slice(0, 42) + last));
});

test('instrument/handoff HELLO and WELCOME are closed; the control hello kind is CONTROL', () => {
  const ih = { contractVersion: 'RevalInstrumentHelloV1', kind: 'CONTROL', helloNonce: u() };
  assert.deepEqual(decodeInstrumentHello(ih), ih);
  for (const bad of [extraKey(ih), { ...ih, kind: 'HANDOFF' }, { ...ih, helloNonce: 'x' }, without(ih, 'kind')]) assert.ok(rejects(() => decodeInstrumentHello(bad)));
  const iw = { contractVersion: 'RevalInstrumentWelcomeV1', helloNonce: u(), registrationId: u(), serverBootId: u(), connectionId: u() };
  assert.deepEqual(decodeInstrumentWelcome(iw), iw);
  assert.ok(rejects(() => decodeInstrumentWelcome(extraKey(iw))) && rejects(() => decodeInstrumentWelcome({ ...iw, connectionId: 'c' })));
  const hh = { contractVersion: 'RevalHandoffHelloV1', helloNonce: u(), controlConnectionId: u() };
  assert.deepEqual(decodeHandoffHello(hh), hh);
  assert.ok(rejects(() => decodeHandoffHello(extraKey(hh))) && rejects(() => decodeHandoffHello(without(hh, 'controlConnectionId'))));
  const hw = { contractVersion: 'RevalHandoffWelcomeV1', helloNonce: u(), registrationId: u(), serverBootId: u(), connectionId: u(), controlConnectionId: u() };
  assert.deepEqual(decodeHandoffWelcome(hw), hw);
  assert.ok(rejects(() => decodeHandoffWelcome({ ...hw, contractVersion: 'RevalInstrumentWelcomeV1' })));
});

test('RevalServerLaunchV2 = the V1 fields + exactly workspaceId, askMode remote, absolute handoff/helper paths and helper digest', () => {
  const l = { contractVersion: 'RevalServerLaunchV2', registrationId: u(), databaseInstanceId: u(), serverBootId: u(), connectionId: u(), launchChallenge: u(),
    endpoint: { socketDir: '/tmp/s', port: 5432, database: 'atlas' }, runtimeRole: 'atlas_runtime', runtimeSecretFile: '/tmp/s/runtime',
    physical: { systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3', postmasterPid: '4', dataDirectory: '/d', socketDevice: '5', socketInode: '6' },
    workspaceId: 'syn-ws-reval', askMode: 'remote', handoffSocketPath: '/tmp/c/reval-handoff.sock', nativePeerHelper: '/tmp/c/peer', nativePeerHelperSha256: 'a'.repeat(64) };
  assert.deepEqual(decodeServerLaunchV2(l), l);
  for (const bad of [extraKey(l), without(l, 'workspaceId'), { ...l, askMode: 'mock' }, { ...l, handoffSocketPath: 'rel.sock' },
    { ...l, nativePeerHelperSha256: 'x' }, { ...l, contractVersion: 'RevalServerLaunchV1' }, without(l, 'runtimeRole')]) assert.ok(rejects(() => decodeServerLaunchV2(bad)));
});

test('RevalPairSecretV1 and the safe PAIR_ACK / ARM_ACK / OBSERVATION_ACK payloads are exact', () => {
  const s = { contractVersion: 'RevalPairSecretV1', registrationId: u(), serverBootId: u(), connectionId: u(), sequence: '3', challenge: u(), requestSequence: '3',
    pairId: u(), instrumentControlConnectionId: u(), instrumentHandoffConnectionId: u(), pairingNonce: newToken(), expiresAt: '2026-10-11T12:02:00.000Z' };
  assert.deepEqual(decodePairSecret(s), s);
  for (const bad of [extraKey(s), { ...s, sequence: '0' }, { ...s, pairingNonce: u() }, { ...s, expiresAt: 'soon' }, without(s, 'requestSequence')]) {
    assert.ok(rejects(() => decodePairSecret(bad)));
  }
  const pa = { pairId: u(), expiresAt: '2026-10-11T12:02:00.000Z', paired: false };
  assert.deepEqual(decodePairAck(pa), pa);
  assert.ok(rejects(() => decodePairAck({ ...pa, pairingNonce: newToken() })) && rejects(() => decodePairAck({ ...pa, paired: 'no' })));
  const aa = { armId: u(), caseId: 'case-01', fixtureId: 'FX10', fixtureGeneration: '2', admissionId: u(), policyVersion: '4', preSnapshotId: u(),
    expiresAt: '2026-10-11T12:00:26.000Z' };
  assert.deepEqual(decodeArmAck(aa), aa);
  for (const bad of [extraKey(aa), { ...aa, fixtureId: 'FX12' }, { ...aa, fixtureGeneration: '0' }, { ...aa, sessionToken: newToken() }]) assert.ok(rejects(() => decodeArmAck(bad)));
  const oa = { armId: u(), observationId: u(), revision: 16, collected: true };
  assert.deepEqual(decodeObservationAck(oa), oa);
  assert.ok(rejects(() => decodeObservationAck({ ...oa, revision: 17 })) && rejects(() => decodeObservationAck({ ...oa, collected: false })));
});

test('Binding and RevalTerminalObservationV1: closed, fault/time latch shape, final only after release with a non-PENDING publication', () => {
  const b = binding();
  assert.deepEqual(decodeBinding(b), b);
  assert.ok(rejects(() => decodeBinding(extraKey(b))) && rejects(() => decodeBinding({ ...b, fixtureId: 'FX00' })) && rejects(() => decodeBinding({ ...b, taskId: 't' })));
  const ok = terminal();
  assert.deepEqual(decodeTerminalObservation(ok), ok);
  const fault = terminal({ detectedFault: 'USAGE_INVALID', detectedAt: '2026-10-11T12:00:01.000Z' });
  assert.deepEqual(decodeTerminalObservation(fault), fault);
  const answered = terminal({ revision: 5, physicalOwnerReleased: true, final: true, reservation: 'COMMITTED', settlement: 'CONFIRMED', attemptId: u(),
    publication: { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null } });
  assert.deepEqual(decodeTerminalObservation(answered), answered);
  const errored = terminal({ physicalOwnerReleased: true, final: true, publication: { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_UNAVAILABLE' } });
  assert.deepEqual(decodeTerminalObservation(errored), errored);
  for (const bad of [extraKey(ok), terminal({ detectedFault: 'USAGE_INVALID' }), terminal({ detectedAt: '2026-10-11T12:00:01.000Z' }),
    terminal({ final: true }), terminal({ physicalOwnerReleased: true, final: true, publication: { state: 'PENDING', kind: 'NONE', status: null, code: null } }),
    terminal({ physicalOwnerReleased: true, final: true }), terminal({ physicalOwnerReleased: true, publication: { state: 'FAILED', kind: 'NONE', status: null, code: null } }),
    terminal({ revision: 17 }), terminal({ revision: 0 }), terminal({ publication: { state: 'SERVER_FINISHED', kind: 'ERROR', status: 500, code: 'ASK_REMOTE_UNAVAILABLE' } }),
    terminal({ publication: { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: 'ASK_DEADLINE' } }),
    terminal({ publication: { state: 'FAILED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_UNAVAILABLE' } }), terminal({ reservation: 'MAYBE' as never })]) {
    assert.ok(rejects(() => decodeTerminalObservation(bad)), JSON.stringify(bad).slice(0, 120));
  }
  assert.equal(Object.keys(PUBLIC_ERROR_STATUS).length, 19);
});

test('transient READY / READY_ACK / TRANSFER / ACK / COMMIT / summary: closed objects and cross-field rules', () => {
  const ready = { contractVersion: 'RevalTransientReadyV1', registrationId: u(), serverBootId: u(), connectionId: u(), sequence: '1', challenge: u(), pairId: u(),
    armId: u(), caseId: 'case-01', fixtureId: 'FX02', fixtureGeneration: '1', admissionId: u(), policyVersion: '3', preSnapshotId: u() };
  assert.deepEqual(decodeReady(ready), ready);
  assert.ok(rejects(() => decodeReady(extraKey(ready))) && rejects(() => decodeReady({ ...ready, sequence: '0' })) && rejects(() => decodeReady({ ...ready, fixtureId: 'X' })));
  const rack = { contractVersion: 'RevalTransientReadyAckV1', registrationId: u(), serverBootId: u(), connectionId: u(), sequence: '1', challenge: u(), readySequence: '1',
    armId: u(), disposition: 'READY', failureCode: null };
  assert.deepEqual(decodeReadyAck(rack), rack);
  assert.ok(rejects(() => decodeReadyAck({ ...rack, failureCode: 'ARM_EXPIRED' })) && !rejects(() => decodeReadyAck({ ...rack, disposition: 'FAILED', failureCode: 'ARM_EXPIRED' })));
  const b = binding(); const req = askRequest({ admissionId: b.admissionId, policyVersion: b.policyVersion });
  const transfer = { contractVersion: 'RevalTransientTransferV1', connectionId: b.handoffConnectionId, sequence: '2', challenge: u(), readySequence: '1', transferId: u(),
    ackChallenge: u(), binding: b, bindingResult: 'SERVER_VALUES_MATCHED', publicationAuthority: 'CONFIRMED', handoffAuthority: 'CONFIRMED', request: req,
    response: { status: 200, correlationId: b.correlationId, body: { contractVersion: 'AskAnswerV2' } } };
  assert.deepEqual(decodeTransfer(transfer), transfer);
  for (const bad of [extraKey(transfer), { ...transfer, connectionId: u() }, { ...transfer, publicationAuthority: 'NOT_APPLICABLE' },
    { ...transfer, response: { ...transfer.response, correlationId: u() } }, { ...transfer, request: { ...req, extra: 1 } },
    { ...transfer, response: { status: 503, correlationId: b.correlationId, body: {} } }]) assert.ok(rejects(() => decodeTransfer(bad)));
  assert.ok(!rejects(() => decodeTransfer({ ...transfer, publicationAuthority: 'NOT_APPLICABLE', response: { status: 503, correlationId: b.correlationId, body: {} } })));
  assert.ok(rejects(() => decodeWireResponse({ status: 200, correlationId: u(), body: [] })));
  const ack = { contractVersion: 'RevalTransientAckV1', connectionId: u(), sequence: '3', challenge: u(), transferSequence: '2', transferId: u(), binding: b,
    commitChallenge: u(), disposition: 'ACCEPTED', result: answerResult, failureCode: null };
  assert.deepEqual(decodeAck(ack), ack);
  assert.ok(!rejects(() => decodeAck({ ...ack, disposition: 'REJECTED', result: null, failureCode: 'WRONG_BINDING' })));
  for (const bad of [{ ...ack, result: null }, { ...ack, disposition: 'REJECTED', result: null, failureCode: 'DEADLINE' }, { ...ack, failureCode: 'WRONG_BINDING' }, extraKey(ack)]) {
    assert.ok(rejects(() => decodeAck(bad)));
  }
  assert.ok(!rejects(() => decodeSafeResult(errorResult())) && rejects(() => decodeSafeResult({ ...answerResult, schema: false }))
    && rejects(() => decodeSafeResult({ ...answerResult, requestMatchesFrozen: false })) && rejects(() => decodeSafeResult({ ...errorResult(), claims: true }))
    && rejects(() => decodeSafeResult(errorResult('NOT_A_CODE'))));
  const commit = { contractVersion: 'RevalTransientCommitV1', connectionId: u(), sequence: '4', challenge: u(), ackSequence: '3', transferId: u(), binding: b,
    disposition: 'COMMITTED', failureCode: null };
  assert.deepEqual(decodeCommit(commit), commit);
  assert.ok(!rejects(() => decodeCommit({ ...commit, disposition: 'FAILED', failureCode: 'PAIR_REVOKED' })) && rejects(() => decodeCommit({ ...commit, disposition: 'FAILED', failureCode: 'DEADLINE' })));
  const summary = { contractVersion: 'RevalHandoffSummaryV1', binding: b, transferId: u(), state: 'COMMITTED', result: answerResult, failureCode: null };
  assert.deepEqual(decodeHandoffSummary(summary), summary);
  assert.ok(!rejects(() => decodeHandoffSummary({ ...summary, state: 'UNVERIFIED', result: null, failureCode: 'IPC_LOST' })));
  assert.ok(rejects(() => decodeHandoffSummary({ ...summary, request: req })) && rejects(() => decodeHandoffSummary({ ...summary, state: 'UNVERIFIED', failureCode: null })));
});

test('browser handoff DTOs: PAIR / RESPONSE / PAIR200 / focus exact; fixed failure statuses; error body is only the code', () => {
  const pair = { contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: newToken() };
  assert.deepEqual(decodeHandoffRequest(pair), pair);
  assert.ok(rejects(() => decodeHandoffRequest({ ...pair, pairId: u() })) && rejects(() => decodeHandoffRequest({ ...pair, pairingNonce: u() }))
    && rejects(() => decodeHandoffRequest({ ...pair, operation: 'ARM' })) && rejects(() => decodeHandoffRequest([pair])));
  const b = binding();
  const resp = { contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: u(), receiptNonce: newToken(), request: askRequest(),
    response: { status: 200, correlationId: b.correlationId, body: { contractVersion: 'AskAnswerV2' } } };
  assert.deepEqual(decodeHandoffRequest(resp), resp);
  assert.ok(rejects(() => decodeHandoffRequest({ ...resp, sessionToken: newToken() })) && rejects(() => decodeHandoffRequest({ ...resp, request: 'q' })));
  const focus = { registrationId: u(), fixtureId: 'FX10', fixtureGeneration: '1', requestedFocus: null, focusState: 'NONE', syntheticFreshnessAt: '2026-10-10T07:30:00.000Z' };
  assert.deepEqual(decodeEvaluationFocus(focus), focus);
  assert.ok(rejects(() => decodeEvaluationFocus({ ...focus, focusState: 'FOUND' })) && !rejects(() => decodeEvaluationFocus({ ...focus, focusState: 'MISSING', requestedFocus: 'obs-1' })));
  const p200 = { contractVersion: 'RevalBrowserHandoffV1', pairId: u(), sessionToken: newToken(), serverBootId: u(), expiresAt: '2026-10-11T12:10:00.000Z', evaluationFocus: focus };
  assert.deepEqual(decodePair200(p200), p200);
  assert.ok(rejects(() => decodePair200({ ...p200, pairingNonce: newToken() })));
  assert.deepEqual(['UNAUTHORIZED', 'SCOPE_MISMATCH', 'FRAME_TOO_LARGE', 'PROTOCOL_INVALID', 'DEADLINE', 'PAIR_UNAVAILABLE', 'CONTENT_MISMATCH'].map(c => handoffStatus(c as never)),
    [401, 403, 413, 400, 504, 503, 503]);
  assert.deepEqual(JSON.parse(handoffErrorBody('RAW_EXPIRED')), { contractVersion: 'RevalBrowserHandoffErrorV1', code: 'RAW_EXPIRED' });
});
