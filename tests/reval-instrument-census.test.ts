import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeDrain } from '../packages/reval/census-payloads.ts';
import { RESPONSE_KIND } from '../packages/reval/codes.ts';
import { bindCorpus } from '../scripts/ask-remote-eval-execution/corpus.ts';
import { compareCase, compareGap, segmentBoundaryProblem } from '../scripts/reval-instrument/census.ts';
import type { CensusRecord } from '../scripts/reval-instrument/census.ts';
import { verifyRevision } from '../scripts/reval-instrument/identity.ts';
import { EMITTER, EXPECTED_KIND } from '../scripts/reval-instrument/ipc.ts';
import { GROUPED_ORDER_SHA256, groupedOrder, ORDER_RULE, withGroupedOrder } from '../scripts/reval-instrument/order.ts';
import { MeasuredRun } from '../scripts/reval-instrument/run.ts';
import { terminal } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-D-A instrument checks (rs-d brief A §6): the PRE/POST census verdict of one consumed case (each rule has a detecting case),
// the between-case gap, the segment-boundary rule, and the fixture-grouped order of owner decision D1 (pinned digest, bound to the run).
const EPOCH = randomUUID();
const rec = (over: Partial<Record<string, string>> = {}): CensusRecord => ({ censusId: randomUUID(), guardEpoch: EPOCH, capabilityIngressCount: '3', submitIngressCount: '5',
  handoffIngressCount: '6', rejectedUnpairedCount: '0', unattributedCount: '0', reservationConfirmedCount: '4', commitUnknownCount: '0', capabilityConsumedCount: '0',
  transportEntryCount: '0', publicationCount: '5', physicalReleaseCount: '8', uncollectedTerminalCount: '0', activeTaskCount: '0', pendingCommitCount: '0', coverage: 'COMPLETE',
  ...over }) as CensusRecord;
/** POST = PRE + the given counter deltas. */
const plus = (pre: CensusRecord, d: Record<string, number>, over: Partial<Record<string, string>> = {}): CensusRecord =>
  ({ ...pre, censusId: randomUUID(), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, String(BigInt((pre as never)[k]) + BigInt(v))])), ...over }) as CensusRecord;
const bound = terminal({ reservation: 'COMMITTED', final: true, physicalOwnerReleased: true });
const BOUND = { submitIngressCount: 1, reservationConfirmedCount: 1, publicationCount: 1, physicalReleaseCount: 1, handoffIngressCount: 1 };

test('compareCase: the one submission has exactly one fate and every counter agrees with it; each rule has a detecting case', () => {
  const pre = rec();
  assert.deepEqual(compareCase(pre, plus(pre, BOUND), bound, 1n), { verdict: 'MATCH', reason: null }, 'BOUND, no-key NO_DISPATCH');
  assert.equal(compareCase(pre, plus(pre, { ...BOUND, capabilityConsumedCount: 1, transportEntryCount: 1 }), bound, 1n).verdict, 'MATCH', 'BOUND, dispatched');
  assert.equal(compareCase(pre, plus(pre, {}), null, 0n).verdict, 'MATCH', 'NONE: never clicked');
  assert.equal(compareCase(pre, plus(pre, { submitIngressCount: 1, rejectedUnpairedCount: 1 }), null, 0n).verdict, 'MATCH', 'REJECTED at the gate');
  assert.equal(compareCase(pre, plus(pre, { submitIngressCount: 1, unattributedCount: 1, publicationCount: 1, physicalReleaseCount: 1 }), null, 0n).verdict, 'MATCH',
    'UNATTRIBUTED: claimed, no Binding (pre-auth failure)');
  const unknown = terminal({ reservation: 'COMMIT_UNKNOWN', final: true, physicalOwnerReleased: true });
  assert.equal(compareCase(pre, plus(pre, { ...BOUND, reservationConfirmedCount: 0, commitUnknownCount: 1 }), unknown, 0n).verdict, 'MATCH', 'reserve commit unknown, no row');
  assert.equal(compareCase(pre, plus(pre, { ...BOUND, reservationConfirmedCount: 0, commitUnknownCount: 1 }), unknown, 1n).verdict, 'MATCH', 'reserve commit unknown, a row');
  for (const [d, reason] of [[{ ...BOUND, submitIngressCount: 2 }, 'SUBMIT'], [{ ...BOUND, reservationConfirmedCount: 2 }, 'RESERVATION'],
    [{ ...BOUND, capabilityConsumedCount: 2, transportEntryCount: 2 }, 'DISPATCH']] as const) {
    assert.deepEqual(compareCase(pre, plus(pre, d), bound, 1n), { verdict: 'EXTRA_ACTIVITY', reason }, JSON.stringify(d));
  }
  const cases: [Record<string, number>, ReturnType<typeof terminal> | null, bigint | null, string, Partial<Record<string, string>>?][] = [
    [BOUND, bound, 1n, 'EPOCH', { guardEpoch: randomUUID() }], [BOUND, bound, 1n, 'COVERAGE', { coverage: 'UNKNOWN' }],
    [{ ...BOUND, rejectedUnpairedCount: 1 }, bound, 1n, 'FATE'], [{ ...BOUND, unattributedCount: 1 }, bound, 1n, 'FATE'], [{ submitIngressCount: 1 }, null, 0n, 'FATE'],
    [{}, bound, 1n, 'FATE'], [{ ...BOUND, capabilityIngressCount: 1 }, bound, 1n, 'CAPABILITY'], [{ ...BOUND, handoffIngressCount: 2 }, bound, 1n, 'HANDOFF'],
    [{ ...BOUND, reservationConfirmedCount: 0 }, bound, 0n, 'RESERVATION'], [{ ...BOUND, reservationConfirmedCount: 0, commitUnknownCount: 1 }, bound, 1n, 'RESERVATION'],
    [{ ...BOUND, capabilityConsumedCount: 1 }, bound, 1n, 'DISPATCH'], [{ submitIngressCount: 1, rejectedUnpairedCount: 1, capabilityConsumedCount: 1, transportEntryCount: 1 }, null, 0n, 'DISPATCH'],
    [{ submitIngressCount: 1, rejectedUnpairedCount: 1, publicationCount: 1 }, null, 0n, 'PUBLICATION'], [{ ...BOUND, physicalReleaseCount: 2 }, bound, 1n, 'RELEASE'],
    [{ ...BOUND, uncollectedTerminalCount: 1 }, bound, 1n, 'UNCOLLECTED'], [BOUND, bound, 1n, 'GAUGES', { activeTaskCount: '1', pendingCommitCount: '1' }],
    [BOUND, bound, 0n, 'DB_ATTEMPTS'], [BOUND, bound, 2n, 'DB_ATTEMPTS'], [{ submitIngressCount: -1 }, null, 0n, 'DECREASE'],
    [{ ...BOUND, capabilityConsumedCount: -1, transportEntryCount: -1 }, bound, 1n, 'DECREASE'], [{ ...BOUND, uncollectedTerminalCount: -1 }, bound, 1n, 'DECREASE']];
  for (const [d, t, attempts, reason, over] of cases) {
    assert.deepEqual(compareCase(pre, plus(pre, d, over), t, attempts), { verdict: 'CENSUS_MISMATCH', reason }, `${reason} ${JSON.stringify(d)}`);
  }
  assert.deepEqual(compareCase(pre, plus(pre, BOUND), bound, null), { verdict: 'CENSUS_UNAVAILABLE', reason: 'UNAVAILABLE' });
  // Deferred POST (taken at the next GO): the operator's capability preflight and its owner, and handoff posts, may have moved.
  const deferred = plus(pre, { ...BOUND, capabilityIngressCount: 2, physicalReleaseCount: 3, handoffIngressCount: 3 });
  assert.equal(compareCase(pre, deferred, bound, 1n, true).verdict, 'MATCH');
  assert.equal(compareCase(pre, deferred, bound, 1n).verdict, 'CENSUS_MISMATCH', 'the same traffic in an immediate POST is foreign');
  assert.equal(compareCase(pre, plus(pre, { ...BOUND, physicalReleaseCount: 2 }), bound, 1n, true).reason, 'RELEASE', 'an owner beyond its capability requests');
  assert.equal(compareCase(pre, plus(pre, { ...BOUND, submitIngressCount: 2 }), bound, 1n, true).verdict, 'EXTRA_ACTIVITY');
});

test('compareGap: between two cases only capability requests (with their owners) and browser handoff posts may move', () => {
  const post = rec();
  assert.equal(compareGap(post, plus(post, { capabilityIngressCount: 2, physicalReleaseCount: 2, handoffIngressCount: 1 })).verdict, 'MATCH');
  for (const [d, reason, over] of [[{ submitIngressCount: 1 }, 'SUBMIT'], [{ rejectedUnpairedCount: 1 }, 'SUBMIT'], [{ unattributedCount: 1 }, 'SUBMIT'],
    [{ publicationCount: 1 }, 'SUBMIT'], [{ reservationConfirmedCount: 1 }, 'RESERVATION'], [{ commitUnknownCount: 1 }, 'RESERVATION'],
    [{ capabilityConsumedCount: 1, transportEntryCount: 1 }, 'DISPATCH'], [{ uncollectedTerminalCount: 1 }, 'UNCOLLECTED'], [{ physicalReleaseCount: 1 }, 'RELEASE'],
    [{ capabilityIngressCount: -1 }, 'DECREASE'], [{}, 'EPOCH', { guardEpoch: randomUUID() }], [{}, 'COVERAGE', { coverage: 'UNKNOWN' }]] as const) {
    assert.deepEqual(compareGap(post, plus(post, d as Record<string, number>, over as never)), { verdict: 'CENSUS_MISMATCH', reason }, JSON.stringify(d));
  }
});

test('segment boundary: a CONFIRMED voluntary closure after the previous case and a QUIESCENT, INTACT DRAIN taken after it inside that closure', () => {
  const prev = 'RE-UNS-051';
  const drain = (over: Record<string, string> = {}) => decodeDrain({ snapshotId: randomUUID(), policyVersion: '9', fenceEpoch: '12', registeredProcessCount: '1',
    reachableProcessCount: '1', pendingTaskCount: '0', pendingCommitCount: '0', physicalOwnerCount: '0', unmappedAttemptCount: '0', continuity: 'INTACT', state: 'QUIESCENT', ...over });
  const closure = { kind: 'VOLUNTARY', result: 'CONFIRMED', policyVersion: '9', fenceEpoch: '12' };
  const ok = { afterCaseId: prev, closurePolicyVersion: '9', closureFenceEpoch: '12', drain: drain() };
  assert.equal(segmentBoundaryProblem(prev, [closure], [ok]), null);
  assert.equal(segmentBoundaryProblem(prev, [], [ok]), 'BLOCKED_SEGMENT_CLOSURE_REQUIRED');
  for (const c of [{ ...closure, result: 'CONTAINMENT_UNCONFIRMED' }, { ...closure, kind: 'DAY' }]) assert.equal(segmentBoundaryProblem(prev, [c], [ok]), 'BLOCKED_SEGMENT_CLOSURE_REQUIRED');
  for (const [name, e] of [['no DRAIN', null], ['DRAIN before the previous case', { ...ok, afterCaseId: 'RE-UNS-001' }], ['DRAIN outside the paused closure', { ...ok, closurePolicyVersion: null }],
    ['DRAIN in another closure', { ...ok, closurePolicyVersion: '8', drain: drain({ policyVersion: '8' }) }],
    ['DRAIN after a fence-advancing switch (rc2 N4)', { ...ok, drain: drain({ fenceEpoch: '13' }) }], ['closure fence mismatch', { ...ok, closureFenceEpoch: '11' }], ['PENDING', { ...ok, drain: drain({ state: 'PENDING', pendingTaskCount: '1' }) }],
    ['UNKNOWN', { ...ok, drain: drain({ state: 'UNKNOWN', continuity: 'LOST', reachableProcessCount: '0' }) }], ['policy resumed before the DRAIN', { ...ok, drain: drain({ policyVersion: '10' }) }]] as const) {
    assert.equal(segmentBoundaryProblem(prev, [closure], e === null ? [] : [e as never]), 'BLOCKED_SEGMENT_DRAIN_REQUIRED', name);
  }
});

test('D1 grouped order: first-appearance groups, frozen order inside each group, the pinned digest, and the run binds its corpus to it', () => {
  assert.deepEqual(groupedOrder(['a1', 'b1', 'a2', 'c1', 'b2', 'a3'], id => id[0]!), ['a1', 'a2', 'a3', 'b1', 'b2', 'c1']);
  const ctx = bindCorpus(verifyRevision().snapshot);
  const { corpus, order } = withGroupedOrder(ctx.corpus);
  assert.deepEqual([order.rule, order.sha256, corpus.order.length, new Set(corpus.order).size], [ORDER_RULE, GROUPED_ORDER_SHA256, 200, 200]);
  const fx = (id: string) => corpus.cases.get(id)!.fixtureId;
  const switches = corpus.order.filter((id, i) => i > 0 && fx(id) !== fx(corpus.order[i - 1]!)).length;
  const groups = [...new Set(corpus.order.map(fx))];
  assert.deepEqual([switches, groups], [10, ['FX07', 'FX05', 'FX10', 'FX02', 'FX03', 'FX09', 'FX11', 'FX04', 'FX01', 'FX08', 'FX06']]);
  for (const g of groups) {
    const inGroup = corpus.order.filter(id => fx(id) === g);
    assert.deepEqual(inGroup, ctx.corpus.order.filter(id => fx(id) === g), `${g}: frozen relative order kept`);
  }
  const swapped = [...ctx.corpus.order]; [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  assert.throws(() => withGroupedOrder({ ...ctx.corpus, order: swapped }), /ORDER_DRIFT/, 'another frozen order gives another grouped digest');
  assert.throws(() => new MeasuredRun({ session: null as never, corpus: ctx.corpus, order, ports: null as never, mono: () => 0, wallMs: () => 0, persist: () => true,
    identityHolds: () => true }), /ORDER_DRIFT/, 'a run whose corpus does not follow its order record is refused');
  assert.doesNotThrow(() => new MeasuredRun({ session: null as never, corpus, order, ports: null as never, mono: () => 0, wallMs: () => 0, persist: () => true, identityHolds: () => true }));
});

test('IPC tables: every operation the instrument requests has its 06 response kind and original producer (PROCESS_CENSUS S, DRAIN C)', () => {
  const sources = ['run.ts', 'operator.ts'].map(f => readFileSync(new URL(`../scripts/reval-instrument/${f}`, import.meta.url), 'utf8')).join('\n');
  const ops = [...new Set([...sources.matchAll(/request\('([A-Z_]+)'/g)].map(m => m[1]!))].sort();
  assert.deepEqual(ops, ['ARM_CASE', 'DRAIN', 'END_PAIR', 'IDENTITY', 'PLATFORM_PROOF', 'PRIVACY_PROOF', 'PROCESS_CENSUS', 'SNAPSHOT', 'TERMINAL_OBSERVATION']);
  for (const op of ops) assert.equal(EXPECTED_KIND[op as never], RESPONSE_KIND[op as never], op);
  assert.deepEqual([EMITTER.PROCESS_CENSUS, EMITTER.DRAIN, EMITTER.SNAPSHOT, EMITTER.TERMINAL_OBSERVATION, EMITTER.PLATFORM_PROOF, EMITTER.PRIVACY_PROOF, EMITTER.IDENTITY],
    ['SERVER', 'CONTROLLER', 'CONTROLLER', 'SERVER', 'CONTROLLER', 'CONTROLLER', 'CONTROLLER'], 'RS-D-C: IDENTITY (the run\'s build) is C\'s');
});
