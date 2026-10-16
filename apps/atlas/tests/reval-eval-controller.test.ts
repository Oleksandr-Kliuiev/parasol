import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerEvaluation } from '../packages/reval/eval-controller.ts';
import type { ControllerHooks } from '../packages/reval/eval-controller.ts';
import type { InstrumentConn } from '../packages/reval/eval-instrument-link.ts';
import { binding, terminal } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A controller logic (rs-c brief §3; 04 "Pairing and arm", "First-current-GO bookkeeping" row C; 06 PAIR/ARM/terminal
// rows; rc2 review F7/NB9 and F8) with a fake S link and fake reader hooks: PAIR prerequisites; admission before the seen mark;
// any arm-phase failure after consumption STOPS arming; the active case retires only on its FINAL journaled observation; an
// expired unused arm stops arming; forwarded S responses are kind/schema/binding-checked. Pure; no process, socket or database.
const ADMISSION = randomUUID(); const REGISTRATION = randomUUID(); const BOOT = randomUUID();
const conn = (): InstrumentConn => ({ connectionId: randomUUID(), facts: { pid: 1, pidversion: 1, euid: 0, ppid: 1, startSec: 0, startUsec: 0, hasTty: true, exeMatch: true } });
const CHECK = { fixtureId: 'FX02', fixtureGeneration: '1', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: true, financeUnchanged: true } as never;
type Reply = { kind: string; payload: unknown } | null;
type Server = (op: string, payload: Record<string, unknown>, secret?: { pairId: string }) => Reply;
function setup(server: Server) {
  const now = { t: 1_000_000 }; const wall0 = Date.parse('2026-10-11T12:00:00.000Z');
  const calls: string[] = [];
  const link = { evaluationRequest: async (op: string, payload: Record<string, unknown>, _ms: number, secret?: { pairId: string }) => { calls.push(op); return server(op, payload, secret); } };
  const snapshot = { snapshotId: randomUUID(), dbObservedAt: '2026-10-11T12:00:00.000Z', admissionId: ADMISSION, policyVersion: '3', fenceEpoch: '5', policyState: 'ACTIVE',
    reserveMicroUsd: '300000', dayCapMicroUsd: '2000000', monthCapMicroUsd: '10000000', expiresAt: '2026-10-12T12:00:00.000Z', currentDay: '2026-10-11',
    currentMonth: '2026-10-01', fixtureGeneration: '1', fixtureId: 'FX02', projectAttemptCount: '0', foreignScopeAttemptCount: '0', consistent: true, attempts: [], periods: [] };
  const hooks: ControllerHooks = { server: () => link as never, serialize: fn => fn(), census: null as never, proofs: null as never, now: () => now.t, wallMs: () => wall0 + (now.t - 1_000_000),
    identity: async () => ({ kind: 'IDENTITY', payload: {}, emitter: 'CONTROLLER' }),
    snapshot: async () => { const x = { ...snapshot, snapshotId: randomUUID() }; return { result: { kind: 'SNAPSHOT', payload: x, emitter: 'CONTROLLER' }, snapshot: x as never, completed: now.t }; },
    readCurrent: async () => ({ fixtureId: 'FX02', fixtureGeneration: '1' }), admissionId: ADMISSION, serverBootId: BOOT, registrationId: REGISTRATION };
  const dir = mkdtempSync(join(tmpdir(), 'reval-ctl-')); chmodSync(dir, 0o700);
  const journal = join(dir, 'reval-journal.jsonl');
  const ev = new ControllerEvaluation(hooks, journal, new Map([['case-a', 'FX02'], ['case-b', 'FX02'], ['case-c', 'FX02'], ['case-x', 'FX05']]));
  return { ev, now, calls, journal };
}
const req = (operation: string, payload: Record<string, unknown> = {}) => ({ operation, payload } as never);
const code = (r: { kind: string; payload: unknown }) => r.kind === 'FAILURE' ? (r.payload as { code: string }).code : r.kind;
const echoPair: Server = (op, _p, secret) => op === 'PAIR' ? { kind: 'PAIR_ACK', payload: { pairId: secret!.pairId, expiresAt: '2026-10-11T12:02:00.000Z', paired: false } } : null;
const armAck = (p: Record<string, unknown>): Reply => ({ kind: 'ARM_ACK', payload: { armId: randomUUID(), caseId: p.caseId, fixtureId: 'FX02', fixtureGeneration: '1',
  admissionId: ADMISSION, policyVersion: '3', preSnapshotId: p.preSnapshotId, expiresAt: '2026-10-11T12:00:26.000Z' } });
/** A paired controller; `armReq` exports a fresh PRE snapshot to the control connection first. */
async function paired(other: Server) {
  const s = setup((op, p, secret) => op === 'PAIR' ? echoPair(op, p, secret) : other(op, p, secret));
  const c = conn(); s.ev.connected(c); s.ev.fixtureChecked(CHECK);
  const r = await s.ev.ownerPair({ instrumentControlConnectionId: c.connectionId, instrumentHandoffConnectionId: randomUUID() }, s.now.t + 1800);
  assert.ok(typeof r !== 'string', String(r));
  const pre = async () => ((await s.ev.handle(c, req('SNAPSHOT'), s.now.t)).payload as { snapshotId: string }).snapshotId;
  const armReq = async (caseId: string, over: Record<string, string> = {}) => req('ARM_CASE', { caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId: ADMISSION,
    policyVersion: '3', preSnapshotId: await pre(), browserPairId: r.secret.pairId, ...over });
  const run = async (caseId: string, over: Record<string, string> = {}) => code(await s.ev.handle(c, await armReq(caseId, over), s.now.t));
  return { ...s, c, pairId: r.secret.pairId, armReq, run };
}
const finalFor = (armId: string) => terminal({ binding: binding({ armId, registrationId: REGISTRATION, serverBootId: BOOT }), physicalOwnerReleased: true, final: true,
  publication: { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null } });

test('PAIR: needs an all-true FIXTURE_CHECK of the CURRENT generation and a live control connection; one pair; the ACK must echo the pair', async () => {
  const s = setup(echoPair);
  const c = conn(); s.ev.connected(c);
  const ids = { instrumentControlConnectionId: c.connectionId, instrumentHandoffConnectionId: randomUUID() };
  assert.equal(await s.ev.ownerPair(ids, s.now.t + 1800), 'FIXTURE_MISMATCH', 'no FIXTURE_CHECK yet');
  s.ev.fixtureChecked({ ...(CHECK as object), financeUnchanged: false } as never);
  assert.equal(await s.ev.ownerPair(ids, s.now.t + 1800), 'FIXTURE_MISMATCH', 'a false proof never counts');
  s.ev.fixtureChecked(CHECK);
  assert.equal(await s.ev.ownerPair({ ...ids, instrumentControlConnectionId: randomUUID() }, s.now.t + 1800), 'PAIR_UNAVAILABLE', 'not a live control connection');
  assert.deepEqual(s.calls, [], 'S is never asked before every prerequisite holds');
  const ok = await s.ev.ownerPair(ids, s.now.t + 1800);
  assert.ok(typeof ok !== 'string' && ok.secret.pairingNonce.length === 43);
  assert.equal(await s.ev.ownerPair(ids, s.now.t + 1800), 'PAIR_UNAVAILABLE', 'one pair at a time');
  const bad = setup(op => op === 'PAIR' ? { kind: 'PAIR_ACK', payload: { pairId: randomUUID(), expiresAt: '2026-10-11T12:02:00.000Z', paired: false } } : null);
  const c2 = conn(); bad.ev.connected(c2); bad.ev.fixtureChecked(CHECK);
  assert.equal(await bad.ev.ownerPair({ instrumentControlConnectionId: c2.connectionId, instrumentHandoffConnectionId: randomUUID() }, bad.now.t + 1800), 'PROTOCOL_INVALID');
});

test('ARM admission (not consumed): unpaired connection, unknown case ID, repeated case, active case — never by time alone', async () => {
  const s = await paired((op, p) => op === 'ARM_CASE' ? armAck(p) : null);
  assert.equal(code(await s.ev.handle(conn(), await s.armReq('case-a'), s.now.t)), 'PAIR_UNAVAILABLE', 'only the paired control connection');
  assert.equal(await s.run('case-unknown'), 'FIXTURE_MISMATCH', 'not a frozen case ID');
  assert.equal(await s.run('case-a'), 'ARM_ACK', 'case-a was not consumed by the refused attempts');
  assert.equal(await s.run('case-a'), 'CASE_CONSUMED');
  assert.equal(await s.run('case-b'), 'ARM_UNAVAILABLE', 'case-a is active');
  s.now.t += 27_000;
  assert.equal(await s.run('case-b'), 'ARM_UNAVAILABLE', 'the active case retires on its FINAL observation, never by time alone');
  assert.equal(s.calls.filter(c => c === 'ARM_CASE').length, 1);
  assert.equal(s.ev.stopped, null, 'admission refusals are not arm-phase failures');
});

test('NB9: any failure after consumption stops arming for the process — lost ARM_ACK, S failure, wrong echo/kind/code, stale PRE, wrong fixture', async () => {
  const cases: [string, Server, Record<string, string>][] = [
    ['IPC_LOST', () => null, {}],
    ['POLICY_CHANGED', op => op === 'ARM_CASE' ? { kind: 'FAILURE', payload: { code: 'POLICY_CHANGED' } } : null, {}],
    ['PROTOCOL_INVALID', (op, p) => op === 'ARM_CASE' ? { kind: 'ARM_ACK', payload: { ...(armAck(p)!.payload as object), policyVersion: '4' } } : null, {}],
    ['PROTOCOL_INVALID', op => op === 'ARM_CASE' ? { kind: 'PAIR_ACK', payload: {} } : null, {}],
    ['PROTOCOL_INVALID', op => op === 'ARM_CASE' ? { kind: 'FAILURE', payload: { code: 'NOT_A_CODE' } } : null, {}],
    ['SNAPSHOT_STALE', (op, p) => op === 'ARM_CASE' ? armAck(p) : null, { preSnapshotId: randomUUID() }],
    ['FIXTURE_MISMATCH', (op, p) => op === 'ARM_CASE' ? armAck(p) : null, { fixtureId: 'FX05' }],
  ];
  for (const [want, server, over] of cases) {
    const s = await paired(server);
    assert.equal(await s.run('case-a', over), want);
    assert.equal(s.ev.stopped, 'ARM_PHASE_FAILURE', want);
    assert.equal(await s.run('case-a'), 'CASE_CONSUMED', 'never re-armed');
    assert.equal(await s.run('case-b'), 'ARM_UNAVAILABLE', 'no automatic continuation to the next case');
  }
});

test('terminal observation: kind/binding checked (mismatch = PROTOCOL_INVALID, nothing saved); journaled BEFORE collection; FINAL retires the case', async () => {
  let rec = finalFor(randomUUID());
  let armed: string | null = null;
  const s = await paired((op, p) => {
    if (op === 'ARM_CASE') { const a = armAck(p); armed = (a!.payload as { armId: string }).armId; return a; }
    if (op === 'TERMINAL_OBSERVATION') return { kind: 'TERMINAL_OBSERVATION', payload: rec };
    if (op === 'OBSERVATION_COLLECTED') return { kind: 'OBSERVATION_ACK', payload: { armId: p.armId, observationId: p.observationId, revision: p.revision, collected: true } };
    return null;
  });
  assert.equal(await s.run('case-a'), 'ARM_ACK');
  assert.equal(code(await s.ev.handle(s.c, req('TERMINAL_OBSERVATION', { armId: armed! }), s.now.t)), 'PROTOCOL_INVALID', 'another arm\'s record');
  assert.equal(s.ev.stopped, null, 'a binding mismatch is not a journal failure');
  rec = finalFor(armed!);
  const ok = await s.ev.handle(s.c, req('TERMINAL_OBSERVATION', { armId: armed! }), s.now.t);
  assert.deepEqual([ok.kind, ok.emitter, s.calls.slice(-2)], ['TERMINAL_OBSERVATION', 'SERVER', ['TERMINAL_OBSERVATION', 'OBSERVATION_COLLECTED']]);
  assert.equal(readFileSync(s.journal, 'utf8').trim().split('\n').length, 1, 'only the valid record was journaled');
  assert.equal(await s.run('case-b'), 'ARM_ACK', 'the FINAL collected observation retired case-a');
  // A widened journal: METADATA_PERSIST_FAILED, never collected, arming stops for good.
  chmodSync(s.journal, 0o644); rec = finalFor(armed!);
  const before = s.calls.length;
  assert.equal(code(await s.ev.handle(s.c, req('TERMINAL_OBSERVATION', { armId: armed! }), s.now.t)), 'METADATA_PERSIST_FAILED');
  assert.deepEqual(s.calls.slice(before), ['TERMINAL_OBSERVATION']);
  assert.equal(s.ev.stopped, 'METADATA_PERSIST_FAILED');
});

test('NB9: the CURRENT armed case expired unused (S has no record after expiry) stops arming; losing the control connection ends the pair', async () => {
  const s = await paired((op, p) => op === 'ARM_CASE' ? armAck(p) : op === 'TERMINAL_OBSERVATION' ? { kind: 'FAILURE', payload: { code: 'OBSERVATION_UNAVAILABLE' } }
    : op === 'END_PAIR' ? { kind: 'PAIR_ACK', payload: { pairId: p.pairId, expiresAt: '2026-10-11T12:02:00.000Z', paired: false } } : null);
  const ack = await s.ev.handle(s.c, await s.armReq('case-a'), s.now.t);
  const armId = (ack.payload as { armId: string }).armId;
  s.now.t += 27_000;
  assert.equal(code(await s.ev.handle(s.c, req('TERMINAL_OBSERVATION', { armId: randomUUID() }), s.now.t)), 'OBSERVATION_UNAVAILABLE');
  assert.equal(s.ev.stopped, null, 'another arm ID never retires or stops the current one');
  assert.equal(code(await s.ev.handle(s.c, req('TERMINAL_OBSERVATION', { armId }), s.now.t)), 'OBSERVATION_UNAVAILABLE');
  assert.equal(s.ev.stopped, 'ARM_EXPIRED_UNUSED');
  assert.equal(code(await s.ev.handle(conn(), req('END_PAIR', { pairId: s.pairId }), s.now.t)), 'PAIR_UNAVAILABLE', 'not the paired instrument');
  s.ev.lost(s.c);
  await new Promise(r => setImmediate(r));
  assert.equal(s.calls.at(-1), 'END_PAIR');
});
