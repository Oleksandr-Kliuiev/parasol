import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authorize, DIRECTIONS, FAILURE_CODES, NOT_IMPLEMENTED, OPERATIONS } from '../packages/reval/codes.ts';
import type { Operation, Principal } from '../packages/reval/codes.ts';
import { buildRequest, buildResponse, checkResponse, decodeOperationPayload, decodeRequest, decodeResponse, ResponderState, Sequence } from '../packages/reval/envelope.ts';
import { encodeFrame, FrameDecoder, FrameError, METADATA_FRAME_CAP, parseFrameBody, PRIVATE_FRAME_CAP } from '../packages/reval/frame.ts';
import { decodeChildHello, decodeOwnerExecRequest, decodeOwnerExecResult, decodeServerBound, decodeServerLaunch } from '../packages/reval/private-frames.ts';
import { isDec64, isPositiveDec64, isTime, isUuid, RevalShapeError } from '../packages/reval/scalars.ts';

// R-EVAL RS-A strict local protocol (rs-a/IMPLEMENTATION_BRIEF.md §9, 06_LOCAL_PROTOCOL.md): framing, strict schemas,
// sequencing, the direction table and the closed failure codes. Pure; no process, socket or database.
const B = { registrationId: randomUUID(), serverBootId: randomUUID(), connectionId: randomUUID() };
const frame = (text: string) => { const body = Buffer.from(text, 'utf8'); const h = Buffer.alloc(4); h.writeUInt32BE(body.length); return Buffer.concat([h, body]); };
const parse = (text: string) => parseFrameBody(Buffer.from(text, 'utf8'));

test('FailureCode is EXACTLY the 43 codes of the frozen 06 text, in order', async () => {
  const doc = await readFile(new URL('../docs/stage5/ask/remote/reval-server/06_LOCAL_PROTOCOL.md', import.meta.url), 'utf8');
  const block = doc.slice(doc.indexOf('`FailureCode` is EXACTLY:') + 25, doc.indexOf('Unknown system/DB/exception details'));
  const codes = block.replace(/\s+/g, ' ').split(/[ ,.]+/).filter(c => /^[A-Z_]+$/.test(c));
  assert.equal(FAILURE_CODES.length, 43);
  assert.deepEqual([...FAILURE_CODES], codes);
  assert.equal(new Set(FAILURE_CODES).size, 43);
});

test('framing: oversize declared length refused before buffering; zero length, partial, trailing, BOM, invalid UTF-8, lone surrogates refused', () => {
  const big = Buffer.alloc(4); big.writeUInt32BE(METADATA_FRAME_CAP + 1);
  assert.throws(() => new FrameDecoder(METADATA_FRAME_CAP).push(big), (e: FrameError) => e.code === 'FRAME_TOO_LARGE');
  const priv = Buffer.alloc(4); priv.writeUInt32BE(PRIVATE_FRAME_CAP + 1);
  assert.throws(() => new FrameDecoder(PRIVATE_FRAME_CAP).push(priv), (e: FrameError) => e.code === 'FRAME_TOO_LARGE', 'private cap 4 KiB');
  assert.throws(() => new FrameDecoder(1024).push(Buffer.alloc(4)), (e: FrameError) => e.code === 'PROTOCOL_INVALID', 'zero length');
  const d = new FrameDecoder(1024); const f = frame('{"a":1}');
  assert.deepEqual(d.push(f.subarray(0, 5)), []);
  assert.equal(d.push(f.subarray(5)).length, 1, 'partial frames reassemble');
  const partial = new FrameDecoder(1024); partial.push(f.subarray(0, 6));
  assert.throws(() => partial.end(), FrameError, 'short frame at EOF');
  assert.throws(() => parse('{"a":1} x'), FrameError, 'trailing content');
  assert.throws(() => parseFrameBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), FrameError, 'BOM');
  assert.throws(() => parseFrameBody(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), FrameError, 'invalid UTF-8');
  assert.throws(() => parse('{"a":"\\ud800"}'), FrameError, 'lone high surrogate');
  assert.throws(() => parse('{"\\udc00":1}'), FrameError, 'lone low surrogate in a key');
  assert.deepEqual(parse('{"a":"\\ud83d\\ude00"}'), { a: '😀' });
  assert.throws(() => parse('{"a":1,"b":{"c":1,"c":2}}'), FrameError, 'duplicate key at depth');
  assert.throws(() => encodeFrame({ x: 'y'.repeat(PRIVATE_FRAME_CAP) }, PRIVATE_FRAME_CAP), (e: FrameError) => e.code === 'FRAME_TOO_LARGE');
});

test('scalars: canonical Dec64 strings only, UUIDv4 lowercase, ms UTC times', () => {
  for (const ok of ['0', '1', '9223372036854775807']) assert.ok(isDec64(ok), ok);
  for (const bad of ['01', '+1', '-1', '1e3', '1.0', '9223372036854775808', ' 1', '', 1 as unknown as string]) assert.ok(!isDec64(bad), String(bad));
  assert.ok(!isPositiveDec64('0'));
  assert.ok(isUuid('2f8b1c9e-4d2a-4b6e-9c1d-0a1b2c3d4e5f'));
  for (const bad of ['2F8B1C9E-4D2A-4B6E-9C1D-0A1B2C3D4E5F', '2f8b1c9e-4d2a-1b6e-9c1d-0a1b2c3d4e5f', '2f8b1c9e-4d2a-4b6e-7c1d-0a1b2c3d4e5f']) assert.ok(!isUuid(bad), bad);
  assert.ok(isTime('2026-10-11T23:59:59.999Z'));
  for (const bad of ['2026-10-11T23:59:59Z', '2026-10-11T23:59:59.9999Z', '2026-02-30T00:00:00.000Z', '2026-10-11T23:59:59.999+00:00']) assert.ok(!isTime(bad), bad);
});

const request = (over: Record<string, unknown> = {}) => ({ ...buildRequest(B, randomUUID(), '1', 'IDENTITY', {}), ...over });
test('request envelope: exact keys, versions, ids, Dec64 sequence and the exact payload of every operation', () => {
  assert.equal(decodeRequest(request()).ok, true);
  for (const bad of [{ extra: 1 }, { contractVersion: 'RevalOwnerCommandV2' }, { sequence: 1 }, { sequence: '01' }, { sequence: '0' },
    { registrationId: 'x' }, { operation: 'EXECUTE_SQL' }, { payload: { x: 1 } }]) {
    const d = decodeRequest(request(bad));
    assert.equal(d.ok, false, JSON.stringify(bad));
  }
  const missing = request(); delete (missing as Record<string, unknown>).connectionId;
  assert.equal(decodeRequest(missing).ok, false);
  // Addressable (challenge+sequence extractable) vs not.
  const a = decodeRequest(request({ payload: { x: 1 } }));
  assert.ok(!a.ok && a.addressable !== null);
  const n = decodeRequest(request({ challenge: 'nope' }));
  assert.ok(!n.ok && n.addressable === null);
  const u = randomUUID();
  const payloads: Record<Operation, unknown> = {
    IDENTITY: {}, SNAPSHOT: {}, PROCESS_CENSUS: {}, DRAIN: {}, PLATFORM_PROOF: {}, PRIVACY_PROOF: {}, FIXTURE_CHECK: {},
    TERMINAL_OBSERVATION: { armId: u }, PAIR: { instrumentControlConnectionId: u, instrumentHandoffConnectionId: u }, END_PAIR: { pairId: u },
    ARM_CASE: { caseId: 'C001', fixtureId: 'FX10', fixtureGeneration: '1', admissionId: u, policyVersion: '2', preSnapshotId: u, browserPairId: u },
    PAUSE_EXPORT: { admissionId: u, expectedPolicyVersion: '3', policyFloor: '0', fenceFloor: '0' },
    OBSERVATION_COLLECTED: { armId: u, observationId: u, revision: 16 },
  };
  for (const op of OPERATIONS) {
    assert.doesNotThrow(() => decodeOperationPayload(op, payloads[op]), op);
    assert.throws(() => decodeOperationPayload(op, { ...(payloads[op] as object), extra: true }), RevalShapeError, `${op} extra key`);
  }
  assert.throws(() => decodeOperationPayload('PAUSE_EXPORT', { admissionId: u, expectedPolicyVersion: 3, policyFloor: '0', fenceFloor: '0' }), RevalShapeError, 'JSON number for Dec64');
  assert.throws(() => decodeOperationPayload('PAUSE_EXPORT', { admissionId: u, expectedPolicyVersion: '1e1', policyFloor: '0', fenceFloor: '0' }), RevalShapeError);
  assert.throws(() => decodeOperationPayload('OBSERVATION_COLLECTED', { armId: u, observationId: u, revision: 17 }), RevalShapeError);
  assert.throws(() => decodeOperationPayload('ARM_CASE', { ...(payloads.ARM_CASE as object), fixtureId: 'FX12' }), RevalShapeError);
});

test('responder: per-direction sequence from 1 without gap/reuse, challenge never reused, busy, binding mismatches', () => {
  const s = new ResponderState(B);
  const r = (seq: string, challenge = randomUUID(), over: Record<string, unknown> = {}) => (decodeRequest(request({ sequence: seq, challenge, ...over })) as unknown as { request: never }).request;
  assert.equal(s.check(r('1')), null);
  assert.equal(s.check(r('3')), 'SEQUENCE_INVALID', 'gap');
  const s2 = new ResponderState(B); const c = randomUUID();
  assert.equal(s2.check(r('1', c)), null);
  assert.equal(s2.check(r('2', c)), 'CHALLENGE_INVALID', 'challenge reuse');
  const s3 = new ResponderState(B); assert.equal(s3.check(r('1')), null);
  assert.equal(s3.check(r('1')), 'SEQUENCE_INVALID', 'replay');
  const s4 = new ResponderState(B); s4.busy = true; assert.equal(s4.check(r('1')), 'OPERATION_BUSY');
  assert.equal(new ResponderState(B).check(r('1', randomUUID(), { registrationId: randomUUID() })), 'REGISTRATION_MISMATCH');
  assert.equal(new ResponderState(B).check(r('1', randomUUID(), { serverBootId: randomUUID() })), 'WRONG_BINDING');
  assert.equal(new ResponderState(B).check(r('1', randomUUID(), { connectionId: randomUUID() })), 'WRONG_BINDING');
  const seq = new Sequence(); assert.equal(seq.take(), '1'); assert.equal(seq.take(), '2');
  (seq as unknown as { next: bigint }).next = 9223372036854775808n;
  assert.throws(() => seq.take(), RevalShapeError, 'no wrap past 2^63-1');
});

test('requester: response must echo challenge/requestSequence, next sequence, binding, instance and emitter', () => {
  const out = { challenge: randomUUID(), sequence: '1', operation: 'IDENTITY' as const };
  const inst = randomUUID();
  const resp = (over: Record<string, unknown> = {}) => decodeResponse({ ...buildResponse(B, out, '1', 'CONTROLLER', inst, 'FAILURE', { code: 'DEADLINE' }, '2026-10-11T00:00:00.000Z'), ...over });
  assert.equal(checkResponse(B, new Sequence(), out, resp(), 'CONTROLLER', inst), null);
  assert.equal(checkResponse(B, new Sequence(), out, resp({ challenge: randomUUID() }), 'CONTROLLER', inst), 'CHALLENGE_INVALID');
  assert.equal(checkResponse(B, new Sequence(), out, resp({ requestSequence: '2' }), 'CONTROLLER', inst), 'SEQUENCE_INVALID');
  assert.equal(checkResponse(B, new Sequence(), out, resp({ sequence: '2' }), 'CONTROLLER', inst), 'SEQUENCE_INVALID');
  assert.equal(checkResponse(B, new Sequence(), out, resp({ databaseInstanceId: randomUUID() }), 'CONTROLLER', inst), 'REGISTRATION_MISMATCH');
  assert.equal(checkResponse(B, new Sequence(), out, resp({ connectionId: randomUUID() }), 'CONTROLLER', inst), 'WRONG_BINDING');
  const ok = decodeResponse({ ...buildResponse(B, out, '1', 'SERVER', inst, 'IDENTITY', {}, '2026-10-11T00:00:00.000Z') });
  assert.equal(checkResponse(B, new Sequence(), out, ok, 'CONTROLLER', inst), 'PROTOCOL_INVALID', 'emitter mismatch');
  assert.throws(() => decodeResponse({ ...resp(), emitter: 'INSTRUMENT' }), RevalShapeError);
  assert.throws(() => decodeResponse({ ...resp(), observedAt: '2026-10-11T00:00:00Z' }), RevalShapeError);
});

test('direction table: every operation × sender; instrument owner-only → OWNER_REQUIRED, every other absent pair → WRONG_DIRECTION', () => {
  const senders: Principal[] = ['O', 'I', 'C', 'S'];
  for (const op of OPERATIONS) for (const sender of senders) for (const receiver of senders) {
    const allowed = DIRECTIONS[op].includes(`${sender}->${receiver}`);
    const got = authorize(sender, receiver, op);
    if (allowed) assert.equal(got, null, `${sender}->${receiver} ${op}`);
    else assert.equal(got, sender === 'I' && ['PAIR', 'FIXTURE_CHECK', 'PAUSE_EXPORT'].includes(op) ? 'OWNER_REQUIRED' : 'WRONG_DIRECTION', `${sender}->${receiver} ${op}`);
  }
  assert.equal(authorize('O', 'C', 'ARM_CASE'), 'WRONG_DIRECTION', 'the owner cannot issue the instrument\'s GO arm');
  assert.equal(authorize('O', 'C', 'OBSERVATION_COLLECTED'), 'WRONG_DIRECTION');
  assert.equal(authorize('S', 'C', 'IDENTITY'), 'WRONG_DIRECTION', 'S never sends requests');
  // RS-C-A implements PAIR, END_PAIR, ARM_CASE, TERMINAL_OBSERVATION and OBSERVATION_COLLECTED; RS-D-A PROCESS_CENSUS and DRAIN; RS-D-B
  // PLATFORM_PROOF and PRIVACY_PROOF: every operation is implemented.
  assert.deepEqual(NOT_IMPLEMENTED, {});
});

test('private frames: exact closed shapes; never accepted by the 06 decoder and vice versa', () => {
  const u = () => randomUUID();
  const physical = { systemIdentifier: '7', databaseOid: '16384', postmasterStartTime: '1700000000', postmasterPid: '42', dataDirectory: '/data', socketDevice: '1', socketInode: '2' };
  const endpoint = { socketDir: '/sock', port: 5432, database: 'atlas' };
  const hello = { contractVersion: 'RevalChildHelloV1', kind: 'SERVER', helloNonce: u() };
  assert.doesNotThrow(() => decodeChildHello(hello));
  assert.throws(() => decodeChildHello({ ...hello, kind: 'OWNER' }), RevalShapeError);
  assert.equal(decodeRequest(hello).ok, false, '06 decoder refuses a private frame');
  const launch = { contractVersion: 'RevalServerLaunchV1', registrationId: u(), databaseInstanceId: u(), serverBootId: u(), connectionId: u(),
    launchChallenge: u(), endpoint, runtimeRole: 'atlas_app', runtimeSecretFile: '/s/runtime', physical };
  assert.doesNotThrow(() => decodeServerLaunch(launch));
  for (const bad of [{ endpoint: { ...endpoint, host: '127.0.0.1' } }, { endpoint: { ...endpoint, port: '5432' } }, { runtimeSecretFile: 'rel/path' },
    { physical: { ...physical, socketInode: 2 } }, { password: 'x' }]) assert.throws(() => decodeServerLaunch({ ...launch, ...bad }), RevalShapeError, JSON.stringify(bad));
  assert.throws(() => decodeChildHello(buildRequest(B, u(), '1', 'IDENTITY', {})), RevalShapeError, 'private decoder refuses a 06 frame');
  const bound = { contractVersion: 'RevalServerBoundV1', launchChallenge: u(), serverBootId: u(),
    observed: { systemIdentifier: '7', databaseOid: '1', postmasterStartTime: '1', backendPid: '9', sessionUser: 'atlas_app', unixSocket: true } };
  assert.doesNotThrow(() => decodeServerBound(bound));
  assert.throws(() => decodeServerBound({ ...bound, observed: { ...bound.observed, unixSocket: false } }), RevalShapeError);
  const req = { contractVersion: 'RevalOwnerExecRequestV1', helloNonce: u(), challenge: u(), remainingMs: 1400, registrationId: u(), databaseInstanceId: u(),
    workspaceId: 'ws', clientId: 'c', actorId: 'a', admissionId: u(), expectedPolicyVersion: '3', endpoint, ownerRole: 'atlas_owner', physical, ownerSecretFile: '/s/owner' };
  assert.doesNotThrow(() => decodeOwnerExecRequest(req));
  assert.throws(() => decodeOwnerExecRequest({ ...req, remainingMs: 1401 }), RevalShapeError, 'remainingMs clamp 1..1400');
  assert.throws(() => decodeOwnerExecRequest({ ...req, remainingMs: 0 }), RevalShapeError);
  assert.throws(() => decodeOwnerExecRequest({ ...req, ownerPassword: 'x' }), RevalShapeError, 'no credential field');
  const res = { contractVersion: 'RevalOwnerExecResultV1', challenge: u(), outcome: 'CONFIRMED_COMMIT', revisionApplied: false, policyVersion: '3', fenceEpoch: '4', code: null };
  assert.doesNotThrow(() => decodeOwnerExecResult(res));
  assert.throws(() => decodeOwnerExecResult({ ...res, outcome: 'NOOP_ALREADY_PAUSED' }), RevalShapeError, 'no outcome that implies a commit without one');
  assert.throws(() => decodeOwnerExecResult({ ...res, outcome: 'REFUSED' }), RevalShapeError);
  assert.throws(() => decodeOwnerExecResult({ ...res, outcome: 'COMMIT_UNKNOWN', revisionApplied: null, policyVersion: '3', fenceEpoch: null }), RevalShapeError);
  assert.doesNotThrow(() => decodeOwnerExecResult({ ...res, outcome: 'REFUSED', revisionApplied: null, policyVersion: null, fenceEpoch: null, code: 'POLICY_CHANGED' }));
});
