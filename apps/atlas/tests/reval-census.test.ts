import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeDrain, decodeProcessCensus } from '../packages/reval/census-payloads.ts';
import type { ProcessCensus } from '../packages/reval/census-payloads.ts';
import { CensusLimitError, GuardCensus } from '../packages/reval/eval-census.ts';
import { CensusLink, composeDrain } from '../packages/reval/eval-drain.ts';
import { EvaluationGate, SESSION_HEADER } from '../packages/reval/eval-gate.ts';
import { TerminalObserver } from '../packages/reval/eval-observer.ts';
import { EvaluationState } from '../packages/reval/eval-state.ts';
import { OPERATIONS } from '../packages/reval/codes.ts';
import { ownerEmitter } from '../packages/reval/owner-cli.ts';
import { newToken } from '../packages/reval/eval-wire.ts';
import { binding, rejects, TestClock } from './support/reval-eval-fixtures.ts';
import { fakeSnapshot } from './support/reval-instrument-fixtures.ts';

// R-EVAL RS-D-A guard census, payload schemas and DRAIN composition (rs-d brief A §3/§4; 05 PROCESS_CENSUS, 02 DRAIN, 06 emitter
// rules). Pure: fake request/response objects, the real EvaluationState/TerminalObserver/gate, a fake owner budget and fake S links.
const PORT = 3711;
const REG = { registrationId: randomUUID(), databaseInstanceId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor-reval',
  admissionId: randomUUID() };
const ZERO = { capabilityIngressCount: '0', submitIngressCount: '0', handoffIngressCount: '0', rejectedUnpairedCount: '0', unattributedCount: '0',
  reservationConfirmedCount: '0', commitUnknownCount: '0', capabilityConsumedCount: '0', transportEntryCount: '0', publicationCount: '0', physicalReleaseCount: '0',
  uncollectedTerminalCount: '0', activeTaskCount: '0', pendingCommitCount: '0' };
const censusOf = (over: Record<string, unknown> = {}) => ({ censusId: randomUUID(), guardEpoch: randomUUID(), ...ZERO, coverage: 'COMPLETE', tasks: [], ...over });
const item = (over: Record<string, unknown> = {}) => ({ correlationId: randomUUID(), reservation: 'COMMITTED', capabilityConsumed: false, transportEntered: false,
  noDispatchProof: 'UNAVAILABLE', ownerReleased: true, publication: 'ANSWER', terminalObservationId: randomUUID(), terminalRevision: 3, ...over });

function setup() {
  const clock = new TestClock();
  const state = new EvaluationState({ ...REG, serverBootId: randomUUID() }, clock);
  const observer = new TerminalObserver(clock);
  const owners = { active: 0, releases: 0 };
  const census = new GuardCensus(); census.attach(state, observer); census.attachOwners(owners);
  const gate = new EvaluationGate({ reg: REG, serverBootId: randomUUID(), guardEpoch: census.guardEpoch, port: PORT, state, observer, census,
    requestedFocus: () => null, phases: () => ({ phase1: async () => new Date(), recheck: async () => undefined }) });
  return { clock, state, observer, owners, census, gate };
}
const req = (headers: Record<string, string>): IncomingMessage => ({ headers, headersDistinct: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])) }) as never;
const res = () => new EventEmitter() as unknown as ServerResponse & EventEmitter;
const browser = (extra: Record<string, string> = {}) => ({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin',
  'content-type': 'application/json', ...extra });

test('PROCESS_CENSUS / DRAIN schemas: exact keys, Dec64 counters, gauges 0..4 and every relationship', () => {
  assert.doesNotThrow(() => decodeProcessCensus(censusOf()));
  assert.doesNotThrow(() => decodeProcessCensus(censusOf({ activeTaskCount: '1', pendingCommitCount: '1', tasks: [item({ ownerReleased: false })] })));
  for (const bad of [censusOf({ extra: 1 }), censusOf({ submitIngressCount: '-1' }), censusOf({ submitIngressCount: 1 }), censusOf({ activeTaskCount: '5' }),
    censusOf({ activeTaskCount: '1', pendingCommitCount: '2', tasks: [item({ ownerReleased: false })] }), censusOf({ transportEntryCount: '1' }),
    censusOf({ activeTaskCount: '1' }), censusOf({ coverage: 'PARTIAL' }), censusOf({ tasks: Array.from({ length: 6 }, () => item()) }),
    censusOf({ tasks: [item({ transportEntered: true })] }), censusOf({ tasks: [item({ capabilityConsumed: true, transportEntered: true, reservation: 'COMMIT_UNKNOWN' })] }),
    censusOf({ tasks: [item({ noDispatchProof: 'ORIGINAL_PRIVATE_PROOF', capabilityConsumed: true })] }), censusOf({ tasks: [item({ terminalRevision: null })] }),
    censusOf({ tasks: [item({ correlationId: null })] }), censusOf({ guardEpoch: 'x' })]) {
    assert.ok(rejects(() => decodeProcessCensus(bad)), JSON.stringify(bad).slice(0, 160));
  }
  // An UNKNOWN coverage census may report owners it cannot itemize (never a false COMPLETE).
  assert.doesNotThrow(() => decodeProcessCensus(censusOf({ activeTaskCount: '1', coverage: 'UNKNOWN' })));
  const drain = { snapshotId: randomUUID(), policyVersion: '4', fenceEpoch: '7', registeredProcessCount: '1', reachableProcessCount: '1', pendingTaskCount: '0',
    pendingCommitCount: '0', physicalOwnerCount: '0', unmappedAttemptCount: '0', continuity: 'INTACT', state: 'QUIESCENT' };
  assert.doesNotThrow(() => decodeDrain(drain));
  for (const over of [{ pendingTaskCount: '1' }, { unmappedAttemptCount: '1' }, { continuity: 'LOST' }, { reachableProcessCount: '0' }, { registeredProcessCount: '0', reachableProcessCount: '0' },
    { reachableProcessCount: '2' }, { state: 'DONE' }, { policyVersion: '0' }]) {
    assert.ok(rejects(() => decodeDrain({ ...drain, ...over })), JSON.stringify(over));
  }
  assert.doesNotThrow(() => decodeDrain({ ...drain, pendingTaskCount: '1', state: 'PENDING' }));
});

test('guard census at the gate: every capability/submit entry first; unregistered and Binding-less submits unattributed; completed writes are publications', () => {
  const s = setup();
  assert.equal(s.gate.admit(req({}), 'capability', null, false, res()).kind, 'pass');
  assert.equal(s.gate.admit(req({ [SESSION_HEADER]: newToken() }), 'capability', null, false, res()).kind, 'reject');
  const other = res(); assert.equal(s.gate.admit(req(browser()), 'question', 'syn-client-other', false, other).kind, 'pass');
  assert.equal(s.gate.admit(req(browser({ [SESSION_HEADER]: newToken() })), 'question', 'syn-client-other', false, res()).kind, 'reject');
  assert.equal(s.gate.admit(req(browser()), 'question', REG.clientId, false, res()).kind, 'reject', 'registered client without the header');
  assert.equal(s.gate.admit(req(browser({ [SESSION_HEADER]: newToken() })), 'question', REG.clientId, false, res()).kind, 'reject', 'no claimable arm');
  other.emit('finish');
  const c = s.census.snapshot();
  assert.deepEqual([c.capabilityIngressCount, c.submitIngressCount, c.unattributedCount, c.rejectedUnpairedCount, c.publicationCount], ['2', '4', '1', '2', '1']);
  assert.deepEqual([c.coverage, c.tasks, c.activeTaskCount], ['COMPLETE', [], '0']);
});

test('guard census tasks: records, anonymous owners, seam attribution, the private no-dispatch flag and coverage', () => {
  const s = setup();
  const seams = s.census.wrapSeams({ resolveSecret: () => null, transport: () => { throw new Error('disabled'); } });
  assert.throws(() => seams.transport(Buffer.from(''), 'k', new AbortController().signal));
  assert.equal(s.census.snapshot().coverage, 'UNKNOWN', 'a transport entry without a CLAIMED arm is lost coverage (sticky)');
  const t = setup();
  const b = binding(); t.observer.create(b); t.owners.active = 2;
  let c = t.census.snapshot();
  assert.deepEqual([c.activeTaskCount, c.pendingCommitCount, c.tasks.length, c.tasks.filter(x => x.correlationId === null).length, c.coverage], ['2', '1', 2, 1, 'COMPLETE']);
  t.census.reservation('COMMITTED'); t.observer.reservation(b.armId, 'COMMITTED', randomUUID());
  assert.equal(t.census.snapshot().tasks[0]!.noDispatchProof, 'UNAVAILABLE', 'no proof before the settlement is confirmed');
  t.observer.settlement(b.armId, 'CONFIRMED');
  t.observer.publication(b.armId, { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null }); t.observer.released(b.armId); t.owners.active = 0; t.owners.releases = 2;
  c = t.census.snapshot();
  assert.deepEqual([c.reservationConfirmedCount, c.physicalReleaseCount, c.activeTaskCount, c.pendingCommitCount], ['1', '2', '0', '0']);
  assert.deepEqual([c.tasks[0]!.noDispatchProof, c.tasks[0]!.publication, c.tasks[0]!.ownerReleased], ['ORIGINAL_PRIVATE_PROOF', 'ANSWER', true],
    'committed, never consumed, settlement confirmed: the in-process NO_DISPATCH proof');
  t.owners.active = 0; t.observer.create(binding()); // a record without its owner: the owner count does not reconcile
  assert.equal(t.census.snapshot().coverage, 'UNKNOWN');
  const u = setup(); u.owners.active = 4; for (let i = 0; i < 2; i += 1) { const x = binding(); u.observer.create(x); u.observer.released(x.armId); }
  assert.throws(() => u.census.snapshot(), CensusLimitError, 'more items than 05 allows is CENSUS_LIMIT_EXCEEDED, never truncated');
});

test('composeDrain: QUIESCENT only for two equal complete censuses with idle gauges, nothing unmapped and intact continuity; else PENDING/UNKNOWN', () => {
  const epoch = randomUUID();
  const c = (over: Record<string, unknown> = {}): ProcessCensus => decodeProcessCensus(censusOf({ guardEpoch: epoch, ...over }));
  const snap = (attempts: { correlationId: string; state: 'EGRESS_COMMITTED' | 'SETTLED' }[] = [], over: Record<string, unknown> = {}) =>
    ({ ...fakeSnapshot({ admissionId: REG.admissionId, policyState: 'PAUSED', attempts: attempts.map(a => ({ ...a, outcome: a.state === 'SETTLED' ? 'NO_DISPATCH' : null,
      accounted: a.state === 'SETTLED' ? '0' : '300000' })) }), ...over });
  const quiet = composeDrain(c(), snap([{ correlationId: randomUUID(), state: 'SETTLED' }]), c(), 'INTACT', 'COMPLETE');
  assert.deepEqual([quiet.state, quiet.continuity, quiet.reachableProcessCount, quiet.unmappedAttemptCount], ['QUIESCENT', 'INTACT', '1', '0']);
  const corr = randomUUID(); const busy = { activeTaskCount: '1', pendingCommitCount: '1', tasks: [item({ correlationId: corr, ownerReleased: false, publication: 'NONE' })] };
  for (const [name, c1, s, c2, cont] of [
    ['a counter moved', c(), snap(), c({ capabilityIngressCount: '1', physicalReleaseCount: '1' }), 'INTACT'],
    ['an owner is still active', c(busy), snap([{ correlationId: corr, state: 'EGRESS_COMMITTED' }]), c(busy), 'INTACT'],
    ['an unsettled attempt no census task maps', c(), snap([{ correlationId: randomUUID(), state: 'EGRESS_COMMITTED' }]), c(), 'INTACT']] as const) {
    assert.equal(composeDrain(c1, s as never, c2, cont, 'COMPLETE').state, 'PENDING', name);
  }
  for (const [name, c1, s, c2, cont] of [['S unreachable', c(), snap(), null, 'INTACT'], ['coverage UNKNOWN', c(), snap(), c({ coverage: 'UNKNOWN' }), 'INTACT'],
    ['continuity lost', c(), snap(), c(), 'LOST'], ['another epoch', c(), snap(), decodeProcessCensus(censusOf()), 'INTACT'],
    ['inconsistent snapshot', c(), snap([], { consistent: false }), c(), 'INTACT'], ['foreign attempts', c(), snap([], { foreignScopeAttemptCount: '1' }), c(), 'INTACT']] as const) {
    assert.equal(composeDrain(c1, s as never, c2, cont, 'COMPLETE').state, 'UNKNOWN', name);
  }
  // RS-D-B (02 "incomplete process inventory is UNKNOWN, never zero"): everything idle, but C's process inventory is not complete.
  assert.equal(composeDrain(c(), snap(), c(), 'INTACT', 'INCOMPLETE').state, 'UNKNOWN', 'no independent process inventory');
});

test('CensusLink: S answers forwarded as SERVER; the first guardEpoch is C\'s for good — another one is IDENTITY_UNVERIFIED and every later DRAIN is LOST', async () => {
  let epoch: string = randomUUID(); let calls = 0; const order: string[] = [];
  const link = { evaluationRequest: async (op: string) => { calls += 1; order.push(op); return op === 'PROCESS_CENSUS' ? { kind: 'PROCESS_CENSUS', payload: censusOf({ guardEpoch: epoch }) } : null; } };
  const snapshot = fakeSnapshot({ admissionId: REG.admissionId, policyState: 'PAUSED' });
  const cl = new CensusLink({ server: () => link as never, now: () => 0,
    snapshot: async () => { order.push('SNAPSHOT'); return { result: { kind: 'SNAPSHOT', payload: snapshot, emitter: 'CONTROLLER' }, snapshot }; },
    inventory: async () => { order.push('INVENTORY'); return 'COMPLETE'; } });
  const first = await cl.census(1800);
  assert.deepEqual([first.kind, first.emitter], ['PROCESS_CENSUS', 'SERVER']);
  const d = await cl.drain(1800);
  assert.deepEqual([d.kind, d.emitter, (d.payload as { state: string }).state, calls], ['DRAIN', 'CONTROLLER', 'QUIESCENT', 3]);
  assert.deepEqual(order, ['PROCESS_CENSUS', 'PROCESS_CENSUS', 'SNAPSHOT', 'PROCESS_CENSUS', 'INVENTORY'], 'census₁ → atomic snapshot → census₂ → C\'s inventory');
  for (const [inventory, why] of [[async () => 'INCOMPLETE' as const, 'an incomplete inventory'], [async () => { throw new Error('read'); }, 'a failed inventory read']] as const) {
    const same = new CensusLink({ server: () => link as never, now: () => 0, snapshot: async () => ({ result: { kind: 'SNAPSHOT', payload: snapshot, emitter: 'CONTROLLER' }, snapshot }),
      inventory: inventory as () => Promise<'COMPLETE' | 'INCOMPLETE'> });
    const x = await same.drain(1800);
    assert.deepEqual([x.kind, (x.payload as { state: string; continuity: string }).state, (x.payload as { continuity: string }).continuity], ['DRAIN', 'UNKNOWN', 'INTACT'], why);
  }
  epoch = randomUUID();
  const other = await cl.census(1800);
  assert.deepEqual([other.kind, (other.payload as { code: string }).code, cl.continuity], ['FAILURE', 'IDENTITY_UNVERIFIED', 'LOST']);
  epoch = (first.payload as { guardEpoch: string }).guardEpoch;
  assert.equal(((await cl.drain(1800)).payload as { continuity: string; state: string }).state, 'UNKNOWN', 'a lost continuity is sticky');
  const bad = new CensusLink({ server: () => ({ evaluationRequest: async () => ({ kind: 'PROCESS_CENSUS', payload: { ...censusOf(), extra: 1 } }) }) as never, now: () => 0,
    snapshot: async () => ({ result: { kind: 'SNAPSHOT', payload: snapshot, emitter: 'CONTROLLER' }, snapshot }), inventory: async () => 'COMPLETE' });
  assert.equal(((await bad.census(1800)).payload as { code: string }).code, 'PROTOCOL_INVALID', 'an invalid S census is never forwarded');
  const gone = new CensusLink({ server: () => null, now: () => 0, snapshot: async () => ({ result: { kind: 'SNAPSHOT', payload: snapshot, emitter: 'CONTROLLER' }, snapshot }),
    inventory: async () => 'INCOMPLETE' });
  assert.equal(((await gone.drain(1800)).payload as { state: string; reachableProcessCount: string }).state, 'UNKNOWN', 'no S: UNKNOWN, never zero');
});

test('06 emitters at O: PROCESS_CENSUS and TERMINAL_OBSERVATION are S\'s payloads, DRAIN and every other kind C\'s', () => {
  const server = OPERATIONS.filter(op => ownerEmitter(op) === 'SERVER');
  assert.deepEqual([...server].sort(), ['PROCESS_CENSUS', 'TERMINAL_OBSERVATION']);
  assert.equal(ownerEmitter('DRAIN'), 'CONTROLLER');
});
