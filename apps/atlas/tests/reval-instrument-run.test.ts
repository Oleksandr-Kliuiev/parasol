import { verifyTestRevision } from './support/reval-history.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { decodeProcessCensus } from '../packages/reval/census-payloads.ts';
import { READY_ACK_V1 } from '../packages/reval/eval-transient.ts';
import { bindCorpus } from '../scripts/ask-remote-eval-execution/corpus.ts';
import { FakeV2, fakeRequest } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { buildReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { ExecutionSession } from '../scripts/ask-remote-eval-execution/session.ts';
import { withGroupedOrder } from '../scripts/reval-instrument/order.ts';
import { assertReceiptV6, buildReceiptV6, effectiveOf } from '../scripts/reval-instrument/receipt.ts';
import { CASE_PAIR_RESERVE_MS, HANDOFF_SETTLE_MS, MeasuredRun, SLOT_CLEAR_MS } from '../scripts/reval-instrument/run.ts';
import { PAIR_MAX_MS, PAIR_NONCE_MS } from '../packages/reval/eval-state.ts';
import { terminal } from './support/reval-eval-fixtures.ts';
import { fakeSnapshot } from './support/reval-instrument-fixtures.ts';

// R-EVAL RS-C-B GO state machine (rs-c brief B §4, §8 rc2; carried N2): the measured run on the UNCHANGED RC5 ExecutionSession with
// fake control (C) and handoff (S) ports and injected clocks. Before anything is consumed, the next GO needs the previous case's
// terminal record FINAL and (re-)collected and — unless its handoff COMMITTED — 125 s past its GO with its transfer reader ended
// plus S's handoff deadline; an arm S never claimed stops arming once expired (NB9). rc2: a detected fault in any record blocks
// credit and arming and makes the run FAILED; a case without a FINAL record or with a contradicting publication is never credited;
// a record or READY_ACK that does not answer I's own READY is refused; once armed, a failure ends I's pair. Synthetic values only.
const SNAP = verifyTestRevision().snapshot; const REV = verifyTestRevision().revision!;
const CTX = bindCorpus(SNAP);
// RS-D-A: the run follows the fixture-grouped order (owner decision D1); `supportedFirst` rigs use a custom order (no v4 receipt).
const GROUPED = withGroupedOrder(CTX.corpus); const { corpus } = GROUPED;
const ADM = randomUUID(); const V = '7'; const BUILD = 'c'.repeat(64);
const START = Date.parse('2026-10-12T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
type Reply = { kind: string; payload: unknown; emitter: string };
type Mode = { final: boolean; fault?: string; publication?: Record<string, unknown>; binding?: Record<string, string> };
const ANSWER_PUBLICATION = { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null };

/** The frozen order with a SUPPORTED case first (a single failure then cannot end the run by threshold); the corpus is unchanged. */
const SUPPORTED_FIRST = (() => { const f = CTX.corpus.order; const s = f.find(id => corpus.cases.get(id)!.group.startsWith('SUPPORTED_'))!; return [s, ...f.filter(id => id !== s)]; })();
interface RigOptions { readyDisposition?: 'READY' | 'FAILED'; readyBoot?: string; readyPad?: boolean; armEcho?: Record<string, string>; supportedFirst?: boolean }
function rig(o: RigOptions = {}) {
  const clock = { utcMs: START, monoMs: 1_000 }; let n = 0;
  const corpus = o.supportedFirst ? { ...CTX.corpus, order: SUPPORTED_FIRST } : GROUPED.corpus;
  const order = o.supportedFirst ? { rule: 'TEST_SUPPORTED_FIRST', sha256: createHash('sha256').update(SUPPORTED_FIRST.join('\n')).digest('hex'),
    frozenOrderSha256: GROUPED.order.frozenOrderSha256 } : GROUPED.order;
  const fake = new FakeV2(corpus.fixtures, corpus.scope, { admissionId: ADM, version: V, fence: '7', dayCap: 2_000_000, monthCap: 10_000_000 });
  const session = new ExecutionSession({ runClass: 'UNADMITTED_LOCAL_OBSERVATION', clock: () => ({ ...clock }), verify: () => SNAP,
    nonce: () => `n${(n += 1).toString(36).padStart(5, '0')}`, corpus },
  { admissionId: ADM, startUtc: iso(START), expiryUtc: iso(START + 6 * 86_400_000), dayCapMicro: '2000000', monthCapMicro: '10000000', openingFenceEpoch: '7', pacingMax: '10' });
  const log: string[] = []; const attempts: Parameters<typeof fakeSnapshot>[0]['attempts'] & object[] = [];
  const readies = new Map<string, Record<string, unknown>>(); const correlations = new Map<string, string>();
  const control = { binding: { registrationId: randomUUID(), serverBootId: randomUUID(), connectionId: randomUUID() }, closed: false,
    handlers: {} as Record<string, (p: Record<string, unknown>) => Reply>,
    async request(op: string, payload: Record<string, unknown>): Promise<Reply> { log.push(op); return control.handlers[op]!(payload); } };
  let fixtureId = 'FX07'; let armExpires = 0; let holds = true; let mode: Mode = { final: true };
  const snapshotOf = (over: Record<string, unknown> = {}, admissionId = ADM) =>
    ({ ...fakeSnapshot({ admissionId, policyVersion: V, fixtureId, now: iso(clock.utcMs), attempts: [...attempts] }), ...over });
  control.handlers.SNAPSHOT = () => ({ kind: 'SNAPSHOT', payload: snapshotOf(), emitter: 'CONTROLLER' });
  // RS-D-C: C's IDENTITY (the run binds to its build digest `BUILD`).
  control.handlers.IDENTITY = () => ({ kind: 'IDENTITY', emitter: 'CONTROLLER', payload: { databaseInstanceId: randomUUID(), buildManifestSha256: BUILD, runtimeImageSha256: BUILD,
    launcherManifestSha256: BUILD, platformEvidenceRef: 'test-platform-ref', loadedBinding: 'UNVERIFIED', startedAt: iso(START) } });
  control.handlers.ARM_CASE = p => { armExpires = clock.utcMs + 26_000; return { kind: 'ARM_ACK', emitter: 'SERVER', payload: { armId: randomUUID(), caseId: p.caseId, fixtureId: p.fixtureId,
    fixtureGeneration: p.fixtureGeneration, admissionId: p.admissionId, policyVersion: p.policyVersion, preSnapshotId: p.preSnapshotId, expiresAt: iso(armExpires), ...o.armEcho } }; };
  control.handlers.END_PAIR = () => ({ kind: 'PAIR_ACK', payload: {}, emitter: 'SERVER' });
  /** S's record for `armId`: the Binding of I's own READY (plus the handed-off correlation) unless the mode overrides it. */
  const terminalFor = (armId: string): Record<string, unknown> => {
    const r = readies.get(armId)!;
    const binding = { registrationId: r.registrationId, serverBootId: r.serverBootId, guardEpoch: randomUUID(), handoffConnectionId: handoff.connectionId, pairId: r.pairId,
      armId, taskId: randomUUID(), caseId: r.caseId, fixtureId: r.fixtureId, fixtureGeneration: r.fixtureGeneration, admissionId: r.admissionId, policyVersion: r.policyVersion,
      preSnapshotId: r.preSnapshotId, correlationId: correlations.get(armId) ?? randomUUID(), ...mode.binding } as never;
    const fault = mode.fault ? { detectedFault: mode.fault as never, detectedAt: iso(clock.utcMs) } : {};
    // RS-D-A: an arm whose question created an attempt has a COMMITTED reservation in S's record (as the real observer latches it).
    const reserved = correlations.has(armId) ? { reservation: 'COMMITTED' as const, attemptId: randomUUID() } : {};
    return (mode.final
      ? terminal({ binding, revision: 3, physicalOwnerReleased: true, final: true, publication: (mode.publication ?? ANSWER_PUBLICATION) as never, ...fault, ...reserved })
      : terminal({ binding, ...fault, ...reserved })) as unknown as Record<string, unknown>;
  };
  /** The fake S's latest record per arm it handed out (the census below counts exactly what those records say happened). */
  const records = new Map<string, Record<string, any>>();
  control.handlers.TERMINAL_OBSERVATION = p => { const t = terminalFor(p.armId as string); records.set(p.armId as string, t); return { kind: 'TERMINAL_OBSERVATION', payload: t, emitter: 'SERVER' }; };
  /** RS-D-A: S's guard census as the fake S counts it — one submission per claimed arm (a record), its reservation and dispatch, its
   *  publication and owner release — plus `censusExtra` deltas a test injects. */
  const censusExtra: Record<string, bigint> = {}; let epoch: string = randomUUID(); let forcedActive: number | null = null;
  control.handlers.PROCESS_CENSUS = () => {
    const rs = [...records.values()]; const count = (f: (t: Record<string, any>) => boolean) => BigInt(rs.filter(f).length);
    const committed = count(t => t.reservation === 'COMMITTED'); const active = forcedActive === null ? count(t => !t.physicalOwnerReleased) : BigInt(forcedActive);
    const c: Record<string, bigint> = { capabilityIngressCount: 0n, submitIngressCount: BigInt(rs.length), handoffIngressCount: 0n, rejectedUnpairedCount: 0n, unattributedCount: 0n,
      reservationConfirmedCount: committed, commitUnknownCount: 0n, capabilityConsumedCount: committed, transportEntryCount: committed,
      publicationCount: count(t => t.publication.state === 'SERVER_FINISHED'), physicalReleaseCount: count(t => t.physicalOwnerReleased), uncollectedTerminalCount: 0n };
    for (const [k, v] of Object.entries(censusExtra)) c[k] = (c[k] ?? 0n) + v;
    const task = { correlationId: null, reservation: 'NONE_CONFIRMED', capabilityConsumed: false, transportEntered: false, noDispatchProof: 'UNAVAILABLE', ownerReleased: false,
      publication: 'NONE', terminalObservationId: null, terminalRevision: null };
    return { kind: 'PROCESS_CENSUS', emitter: 'SERVER', payload: decodeProcessCensus({ censusId: randomUUID(), guardEpoch: epoch, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
      activeTaskCount: String(active), pendingCommitCount: String(active), coverage: 'COMPLETE', tasks: Array.from({ length: Number(active) }, () => task) }) };
  };
  // The handoff port: frames are queued or awaited; `fail` ends the waiting reader with an IPC code (e.g. S's raw-slot bound).
  const queue: Record<string, unknown>[] = []; let waiter: { res: (f: Record<string, unknown>) => void; rej: (e: Error) => void } | null = null;
  const push = (f: Record<string, unknown>) => { if (waiter) { const w = waiter; waiter = null; w.res(f); } else queue.push(f); };
  const fail = (code: string) => { const w = waiter; waiter = null; w?.rej(Object.assign(new Error(code), { code })); };
  const sent: Record<string, unknown>[] = []; let onReady: ((f: Record<string, unknown>, seq: string) => void) | null = null;
  const handoff = { connectionId: randomUUID(), closed: false,
    send(f: Record<string, unknown>) {
      sent.push(f); const seq = String(sent.length);
      if (f.contractVersion === 'RevalTransientReadyV1') {
        readies.set(f.armId as string, f); log.push('READY');
        const disposition = o.readyDisposition ?? 'READY';
        push({ contractVersion: READY_ACK_V1, registrationId: control.binding.registrationId, serverBootId: o.readyBoot ?? control.binding.serverBootId, connectionId: handoff.connectionId,
          sequence: seq, challenge: f.challenge, readySequence: seq, armId: f.armId, disposition, failureCode: disposition === 'READY' ? null : 'ARM_UNAVAILABLE',
          ...(o.readyPad ? { padding: 'x'.repeat(5000) } : {}) });
        onReady?.(f, seq);
      }
      return seq;
    },
    next: () => queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<Record<string, unknown>>((res, rej) => { waiter = { res, rej }; }) };
  const run: MeasuredRun = new MeasuredRun({ session, corpus, order, ports: { control: control as never, handoff }, mono: () => clock.monoMs, wallMs: () => clock.utcMs,
    persist: () => { const m = [...run.cases.values()].at(-1); log.push(`PERSIST armIssued=${m?.armIssued ?? 'none'} armId=${m?.armId ? 'set' : 'none'}`); return true; },
    identityHolds: () => holds });
  run.setPair({ pairId: randomUUID(), expiresAt: iso(clock.utcMs + 120_000), paired: false });
  assert.equal(run.confirm(ADM, V), 'CONFIRMED');
  /** RC5 capability/stage/consent for the next frozen case (the GO preconditions the operator types). */
  const prepare = (): string => {
    clock.utcMs += 13_000; clock.monoMs += 13_000;
    const id = session.nextCaseId!; const c = corpus.cases.get(id)!; fixtureId = c.fixtureId;
    assert.equal(session.capability(fake.capability().http), 'OK');
    assert.equal(session.stage(id, corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus ?? 'none', c.question), 'STAGED');
    assert.equal(session.consent(id, session.consentChallenge(id), true), 'CONSENTED');
    return id;
  };
  /** S answers the READY with the accepted fake V2's exact values (a valid TRANSFER) and COMMITs the ACK. */
  const answerAndCommit = (id: string, settle: { outcome: string; accounted: string; state?: 'SETTLED' | 'UNKNOWN' }, script?: Record<string, unknown>) => {
    onReady = (r, seq) => {
      const c = corpus.cases.get(id)!; const fx = corpus.fixtures.get(c.fixtureId)!;
      const requestText = fakeRequest(id, c.question, fx.spec.requestedFocus, fake.tuple);
      const reply = fake.ask(requestText, c.fixtureId, (script ?? { kind: 'INTENT', intent: c.expectedIntent }) as never, clock.utcMs);
      assert.ok(reply.http !== 'TIMEOUT');
      attempts.push({ correlationId: reply.correlationId!, state: settle.state ?? 'SETTLED', outcome: settle.outcome, accounted: settle.accounted });
      correlations.set(r.armId as string, reply.correlationId!);
      const b = { registrationId: r.registrationId as string, serverBootId: r.serverBootId as string, guardEpoch: randomUUID(), handoffConnectionId: handoff.connectionId,
        pairId: r.pairId as string, armId: r.armId as string, taskId: randomUUID(), caseId: id, fixtureId: c.fixtureId, fixtureGeneration: r.fixtureGeneration as string,
        admissionId: ADM, policyVersion: V, preSnapshotId: r.preSnapshotId as string, correlationId: reply.correlationId! };
      const transfer = { contractVersion: 'RevalTransientTransferV1', connectionId: handoff.connectionId, sequence: String(Number(seq) + 1), challenge: r.challenge,
        readySequence: seq, transferId: randomUUID(), ackChallenge: randomUUID(), binding: b, bindingResult: 'SERVER_VALUES_MATCHED',
        publicationAuthority: reply.http.status === 200 ? 'CONFIRMED' : 'NOT_APPLICABLE', handoffAuthority: 'CONFIRMED', request: JSON.parse(requestText),
        response: { status: reply.http.status, correlationId: reply.correlationId, body: JSON.parse(String(reply.http.body)) } };
      const sendAck = handoff.send;
      handoff.send = f => { const s = sendAck.call(handoff, f); if (f.disposition === 'ACCEPTED') { handoff.send = sendAck;
        push({ contractVersion: 'RevalTransientCommitV1', connectionId: handoff.connectionId, sequence: String(Number(s) + 1), challenge: f.commitChallenge, ackSequence: s,
          transferId: transfer.transferId, binding: b, disposition: 'COMMITTED', failureCode: null }); } return s; };
      setImmediate(() => push(transfer));
    };
  };
  const receipt = (): Record<string, any> => {
    if (o.supportedFirst) { const base = buildReceipt(session, CTX.cases) as Record<string, any>; return { base, effective: effectiveOf(String(base.run.state), run) }; }
    return buildReceiptV6(session, run, CTX.cases, REV, { registrationId: control.binding.registrationId, serverBootId: control.binding.serverBootId,
      controlConnectionId: control.binding.connectionId, handoffConnectionId: handoff.connectionId });
  };
  const setMode = (m: Mode) => { mode = m; };
  const casePass = (id: string) => receipt().base.cases.find((x: { caseId: string }) => x.caseId === id)?.casePass;
  const facts = () => { const f = session.facts(); return { state: f.state, safety: Object.fromEntries([...f.safety].filter(([, k]) => k > 0)), handoffFailures: f.handoffFailures }; };
  return { clock, session, run, log, control, handoff, fail, prepare, answerAndCommit, receipt, casePass, setMode, setHolds: (h: boolean) => { holds = h; }, censusExtra, records,
    setEpoch: (e: string) => { epoch = e; }, setActive: (n: number | null) => { forcedActive = n; }, attempts,
    armExpires: () => armExpires, snapshotOf, facts };
}
/** The next case of the grouped order (the same fixture segment, so no boundary closure/DRAIN is needed). */
const nextAfter = (id: string) => corpus.order[corpus.order.indexOf(id) + 1]!;
/** One committed, answered case with the given terminal mode at `finish`. */
async function committedCase(r: ReturnType<typeof rig>, mode: Mode, settle: Parameters<ReturnType<typeof rig>['answerAndCommit']>[1] = { outcome: 'USAGE_VERIFIED', accounted: '222' },
  script?: Record<string, unknown>): Promise<{ id: string; recorded: string }> {
  const id = r.prepare(); r.answerAndCommit(id, settle, script); r.setMode(mode);
  assert.match(await r.run.go(id), new RegExp(`^GO_CLICK_ASK_NOW ${id} \\d+$`));
  assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
  return { id, recorded: await r.run.finish() };
}

test('coverage + N2 terminal gate: a case recorded without a FINAL record gets NO credit; the next GO waits for it BEFORE consumption and re-collects it every time', async () => {
  const r = rig();
  const { id: first, recorded } = await committedCase(r, { final: false });
  assert.match(recorded, new RegExp(`^CASE_RECORDED ${first} \\S+ COMMITTED NO_CREDIT_TERMINAL_NOT_FINAL$`));
  assert.equal(r.casePass(first), false, 'never credited without FINAL coverage');
  assert.ok(['TERMINAL_INCOMPLETE', 'TERMINAL_FAILED'].includes(r.receipt().effective.state));
  const second = nextAfter(first); r.log.length = 0;
  assert.equal(await r.run.go(second), 'BLOCKED_PREVIOUS_TERMINAL_NOT_FINAL');
  assert.deepEqual(r.log.filter(x => !x.startsWith('PERSIST')), ['TERMINAL_OBSERVATION'], 'no PRE snapshot, no ARM');
  assert.equal(r.run.inFlight, null);
  r.setMode({ final: true }); r.log.length = 0;
  const snapshotOk = r.control.handlers.SNAPSHOT!; const gap = { kind: 'FAILURE', payload: { code: 'OBSERVATION_GAP' }, emitter: 'CONTROLLER' };
  r.control.handlers.SNAPSHOT = () => gap;
  // RS-D-A: the case was recorded before its record was FINAL, so its POST census is taken now (deferred) and needs its snapshot.
  assert.equal(await r.run.go(second), 'BLOCKED_PREVIOUS_CENSUS_FAILURE_OBSERVATION_GAP', 'nothing consumed; the deferred census is retried');
  assert.deepEqual(r.log.filter(x => !x.startsWith('PERSIST')), ['TERMINAL_OBSERVATION', 'PROCESS_CENSUS', 'SNAPSHOT']);
  assert.deepEqual([r.run.cases.get(first)!.terminal!.final, r.run.cases.get(first)!.census], [true, null], 'the FINAL record is collected; a failed read records no verdict');
  let snapshots = 0; r.control.handlers.SNAPSHOT = () => (snapshots += 1) === 1 ? snapshotOk({}) : gap; r.log.length = 0;
  assert.equal(await r.run.go(second), 'BLOCKED_PRE_FAILURE_OBSERVATION_GAP', 'after collection and the deferred census the GO proceeds to PRE');
  assert.deepEqual(r.log.filter(x => !x.startsWith('PERSIST')), ['TERMINAL_OBSERVATION', 'PROCESS_CENSUS', 'SNAPSHOT', 'PROCESS_CENSUS', 'SNAPSHOT']);
  assert.equal(r.run.cases.get(first)!.census, 'MATCH', 'the deferred census matched');
  r.log.length = 0; await r.run.go(second);
  assert.deepEqual(r.log.filter(x => !x.startsWith('PERSIST')), ['TERMINAL_OBSERVATION', 'PROCESS_CENSUS', 'SNAPSHOT'], 'a FINAL record is re-collected before every PRE (C re-sends COLLECTED)');
  r.control.handlers.TERMINAL_OBSERVATION = () => ({ kind: 'FAILURE', payload: { code: 'OBSERVATION_UNAVAILABLE' }, emitter: 'SERVER' });
  r.log.length = 0; await r.run.go(second);
  assert.deepEqual(r.log.filter(x => !x.startsWith('PERSIST')), ['TERMINAL_OBSERVATION', 'PROCESS_CENSUS', 'SNAPSHOT'], 'a collected FINAL record already swept by S is not a gap');
  // RS-D-C (carried "swept vs expired-uncollected"): the same OBSERVATION_UNAVAILABLE, but S's sticky uncollected count grew (the record
  // expired uncollected) — its own persisted stop BEFORE any consumption, not a generic census change.
  r.censusExtra.uncollectedTerminalCount = 1n; r.log.length = 0;
  assert.equal(await r.run.go(second), 'BLOCKED_ARM_STOPPED_TERMINAL_EXPIRED_UNCOLLECTED');
  assert.deepEqual([r.log.filter(x => !x.startsWith('PERSIST')), r.session.nextCaseId, r.receipt().armStop, r.receipt().effective.state],
    [['TERMINAL_OBSERVATION', 'PROCESS_CENSUS'], second, 'TERMINAL_EXPIRED_UNCOLLECTED', 'TERMINAL_INCOMPLETE'], 'nothing consumed, persisted');
});

test('RS-D-C pair refresh (rc2 F3/N3): the bound comes from the owner\'s PAIR_ACK nonce expiry, not the typing time; refused before consumption', async () => {
  const r = rig(); const { id } = await committedCase(r, { final: true });
  const next = nextAfter(id); r.prepare();
  const ack = (atMs: number) => ({ pairId: randomUUID(), expiresAt: iso(atMs + PAIR_NONCE_MS), paired: false }); // installed at `atMs`
  // The pair lives ≥ expiresAt − nonce window + 10 min; a GO needs CASE_PAIR_RESERVE_MS of it.
  const limit = PAIR_MAX_MS - CASE_PAIR_RESERVE_MS;
  const fresh = ack(r.clock.utcMs); assert.equal(r.run.setPair(fresh), 'PAIR_RECORDED');
  r.clock.monoMs += limit + 1; r.clock.utcMs += limit + 1; r.log.length = 0;
  assert.equal(await r.run.go(next), 'BLOCKED_PAIR_REFRESH_REQUIRED');
  assert.deepEqual([r.log.filter(x => !x.startsWith('PERSIST')), r.session.nextCaseId, r.run.armStop], [[], next, null], 'nothing asked, nothing consumed, no stop');
  assert.equal(r.run.setPair(JSON.stringify(fresh)), 'PAIR_RECORDED'); // N3: re-entering the SAME ack (as a line) does not extend it
  assert.equal(await r.run.go(next), 'BLOCKED_PAIR_REFRESH_REQUIRED');
  // A late `pair-ack` (typed minutes after the owner's pair) gets only what is left of THAT pair.
  assert.equal(r.run.setPair(ack(r.clock.utcMs - limit - 1)), 'PAIR_RECORDED');
  assert.equal(await r.run.go(next), 'BLOCKED_PAIR_REFRESH_REQUIRED', 'installed one limit ago: no case fits any more');
  for (const bad of ['{}', 'not json', JSON.stringify({ ...fresh, paired: true }), JSON.stringify({ ...fresh, extra: 1 }), JSON.stringify({ ...fresh, pairId: 'x' }),
    JSON.stringify({ ...fresh, expiresAt: 'soon' })]) assert.equal(r.run.setPair(bad), 'PAIR_ACK_INVALID', bad);
  assert.equal(r.run.setPair(`OK PAIR_ACK ${JSON.stringify(ack(r.clock.utcMs))}`), 'PAIR_RECORDED', 'the whole owner line is accepted');
  assert.notEqual(await r.run.go(next), 'BLOCKED_PAIR_REFRESH_REQUIRED');
});

test('RS-D-C build binding (rc2 N1/N2): `proofs` first binds C\'s IDENTITY build (persisted) — asked ONCE per run, never again before a GO', async () => {
  const r = rig(); r.log.length = 0;
  const platformOf = (over: Record<string, unknown> = {}) => ({ environmentId: r.control.binding.registrationId, buildManifestSha256: BUILD, serverBootId: r.control.binding.serverBootId,
    policyEvidenceRef: 'rsd-seatbelt-s-v2', destinationInventorySha256: BUILD, intervalStart: iso(START), intervalEnd: iso(START + 1000), processCoverage: 'COMPLETE',
    destinationCoverage: 'UNKNOWN', unexpectedDestinationCount: '0', unknownDestinationCount: '0', unmeasuredProcessCount: '4', mode: 'MEASURED', countsAsVerifiedZero: false, ...over });
  r.control.handlers.PLATFORM_PROOF = () => ({ kind: 'PLATFORM_PROOF', payload: platformOf(), emitter: 'CONTROLLER' });
  r.control.handlers.PRIVACY_PROOF = () => ({ kind: 'PRIVACY_PROOF', emitter: 'CONTROLLER', payload: { environmentId: r.control.binding.registrationId,
    destinationInventorySha256: BUILD, scannerManifestSha256: BUILD, intervalStart: iso(START), intervalEnd: iso(START + 1000), coveredDestinationCount: '3',
    unreadableDestinationCount: '16', newUnclassifiedDestinationCount: '0', forbiddenContentMatchCount: '0', metadataViolationCount: '0', collectionState: 'UNKNOWN',
    externalRetentionEvidenceRef: null, mode: 'MEASURED', countsAsVerifiedZero: false } });
  assert.match(await r.run.takeProofs(), /^PROOFS /);
  const ops = r.log.filter(x => !x.startsWith('PERSIST'));
  assert.deepEqual(ops, ['IDENTITY', 'PLATFORM_PROOF', 'PRIVACY_PROOF'], 'IDENTITY before the first proof');
  assert.ok(r.log.indexOf('IDENTITY') < r.log.findIndex(x => x.startsWith('PERSIST')) && r.log.findIndex(x => x.startsWith('PERSIST')) < r.log.indexOf('PLATFORM_PROOF'),
    `the binding is persisted before the proof is asked: ${r.log.join(',')}`);
  assert.deepEqual([r.run.build, r.receipt().build], [{ buildManifestSha256: BUILD }, { buildManifestSha256: BUILD }]);
  r.log.length = 0; const { id } = await committedCase(r, { final: true });
  assert.ok(!r.log.includes('IDENTITY'), 'bound once: no IDENTITY before a later GO (C ends S on a failed reader recheck — rc2 F1)'); void id;
  r.control.handlers.PLATFORM_PROOF = () => ({ kind: 'PLATFORM_PROOF', payload: platformOf({ buildManifestSha256: 'e'.repeat(64) }), emitter: 'CONTROLLER' });
  assert.equal(await r.run.takeProofs(), 'PROOF_FAILED_PROTOCOL_INVALID', 'a proof of another build than the bound one');
});

test('RS-D-C rc2 F1: S lost (C answers as it really does) is the persisted CENSUS_CONTINUITY_LOST stop — at the first GO, after a case, and at `proofs`', async () => {
  const lose = (r: ReturnType<typeof rig>) => { // C with S gone: IDENTITY → IDENTITY_UNVERIFIED, S-forwarded operations → IPC_LOST
    r.control.handlers.IDENTITY = () => ({ kind: 'FAILURE', payload: { code: 'IDENTITY_UNVERIFIED' }, emitter: 'CONTROLLER' });
    for (const op of ['PROCESS_CENSUS', 'TERMINAL_OBSERVATION']) r.control.handlers[op] = () => ({ kind: 'FAILURE', payload: { code: 'IPC_LOST' }, emitter: 'CONTROLLER' });
  };
  { const r = rig(); const id = r.prepare(); lose(r);
    assert.equal(await r.run.go(id), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST', 'first GO of the run');
    assert.deepEqual([r.session.nextCaseId, r.receipt().armStop, r.receipt().effective.reason], [id, 'CENSUS_CONTINUITY_LOST', 'CENSUS_UNVERIFIED'], 'persisted, nothing consumed'); }
  { const r = rig(); const { id } = await committedCase(r, { final: true }); const next = nextAfter(id); r.prepare(); lose(r);
    assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST', 'after a case: the previous-terminal re-collection answers IPC_LOST');
    assert.equal(r.session.nextCaseId, next); }
  { const r = rig(); lose(r);
    assert.equal(await r.run.takeProofs(), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST', '`proofs` before any GO'); }
  { const r = rig(); const id = r.prepare(); // another IDENTITY failure (no continuity loss) stays retryable
    r.control.handlers.IDENTITY = () => ({ kind: 'FAILURE', payload: { code: 'DEADLINE' }, emitter: 'CONTROLLER' });
    assert.equal(await r.run.go(id), 'BLOCKED_C_IDENTITY_DEADLINE'); assert.equal(r.run.armStop, null); }
  { // an expired-uncollected record after an otherwise clean (ACTIVE) run: its stop makes `effective` CENSUS_UNVERIFIED
    const q = rig(); const { id: a } = await committedCase(q, { final: true }); q.prepare(); q.censusExtra.uncollectedTerminalCount = 1n;
    assert.equal(await q.run.go(nextAfter(a)), 'BLOCKED_ARM_STOPPED_TERMINAL_EXPIRED_UNCOLLECTED');
    assert.deepEqual([q.receipt().effective.state, q.receipt().effective.reason], ['TERMINAL_INCOMPLETE', 'CENSUS_UNVERIFIED']);
  }
});

test('fault precedence (06): an authenticated fault — at finish or in a later revision — blocks credit and arming and makes the run FAILED whatever the handoff', async () => {
  for (const fault of ['USAGE_INVALID', 'UPSTREAM_AUTH', 'MODEL_OR_TIER_MISMATCH']) {
    const r = rig();
    const { id, recorded } = await committedCase(r, { final: true, fault });
    assert.match(recorded, new RegExp(`^CASE_RECORDED ${id} \\S+ COMMITTED NO_CREDIT_TERMINAL_FAULT$`), fault);
    assert.equal(r.run.armStop, 'TERMINAL_FAULT'); assert.equal(r.casePass(id), false);
    assert.deepEqual(r.receipt().effective, { state: 'TERMINAL_FAILED', reason: 'AUTHENTICATED_TERMINAL_FAULT' });
    r.log.length = 0;
    assert.equal(await r.run.go(nextAfter(id)), 'BLOCKED_ARM_STOPPED_TERMINAL_FAULT'); assert.deepEqual(r.log, [], 'nothing requested, nothing consumed');
  }
  const r = rig();
  const { id } = await committedCase(r, { final: false });
  r.setMode({ final: true, fault: 'USAGE_INVALID' });
  assert.equal(await r.run.go(nextAfter(id)), 'BLOCKED_ARM_STOPPED_TERMINAL_FAULT', 'a fault in a later revision stops before PRE');
  assert.deepEqual(r.receipt().effective, { state: 'TERMINAL_FAILED', reason: 'AUTHENTICATED_TERMINAL_FAULT' });
});

test('records that do not answer I: a foreign Binding is refused (not stored, arming stops); a FINAL publication contradicting the COMMITTED handoff gets no credit', async () => {
  { const r = rig();
    const { id, recorded } = await committedCase(r, { final: true, binding: { pairId: randomUUID() } });
    assert.match(recorded, /NO_CREDIT_TERMINAL_NOT_FINAL$/); assert.equal(r.run.cases.get(id)!.terminal, null);
    assert.equal(r.run.armStop, 'OBSERVATION_INVALID');
    assert.ok(['TERMINAL_INCOMPLETE', 'TERMINAL_FAILED'].includes(r.receipt().effective.state)); }
  { const r = rig();
    const { id, recorded } = await committedCase(r, { final: true, binding: { correlationId: randomUUID() } });
    assert.match(recorded, /NO_CREDIT_TERMINAL_NOT_FINAL$/, 'a record for another correlation'); assert.equal(r.run.cases.get(id)!.terminal, null); }
  { const r = rig();
    const { id, recorded } = await committedCase(r, { final: true, publication: { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_UNAVAILABLE' } });
    assert.match(recorded, /NO_CREDIT_TERMINAL_MISMATCH$/); assert.equal(r.run.armStop, 'OBSERVATION_INVALID'); assert.equal(r.casePass(id), false); }
});

test('N2 slot gate: an uncommitted handoff blocks the next GO until 125 s past its GO AND its reader ended + S handoff deadline; an expired unclaimed arm stops arming', async () => {
  const r = rig();
  const first = r.prepare();
  assert.match(await r.run.go(first), /^GO_CLICK_ASK_NOW /);
  const goMono = r.clock.monoMs;
  assert.equal(await r.run.finish(), 'BLOCKED_HANDOFF_PENDING', 'finish never blocks on the background reader');
  assert.equal(r.run.abandonHandoff(), 'HANDOFF_ABANDONED_UNVERIFIED');
  assert.equal(r.run.abandonHandoff(), 'HANDOFF_ALREADY_ABANDONED');
  assert.equal(await r.run.handoff(), 'HANDOFF_UNVERIFIED_RAW_EXPIRED');
  r.control.handlers.TERMINAL_OBSERVATION = () => { throw Object.assign(new Error('lost'), { code: 'IPC_TIMEOUT' }); };
  assert.match(await r.run.finish(), new RegExp(`^CASE_RECORDED ${first} \\S+ UNVERIFIED NO_CREDIT_TERMINAL_NOT_FINAL$`));
  assert.equal(r.run.cases.get(first)!.abandonedByOperator, true);
  assert.equal(r.run.armStop, null, 'not expired yet: no stop');
  const next = nextAfter(first);
  assert.equal(await r.run.go(next), 'BLOCKED_PREVIOUS_SLOT_LIVE', 'reader still waiting');
  r.clock.monoMs = goMono + SLOT_CLEAR_MS + 1;
  assert.equal(await r.run.go(next), 'BLOCKED_PREVIOUS_SLOT_LIVE', '125 s passed but the reader has not ended');
  r.fail('IPC_TIMEOUT'); await new Promise(res => setImmediate(res));
  assert.equal(await r.run.go(next), 'BLOCKED_PREVIOUS_SLOT_LIVE', 'reader ended just now: S handoff deadline margin');
  r.clock.monoMs += HANDOFF_SETTLE_MS;
  r.control.handlers.TERMINAL_OBSERVATION = () => ({ kind: 'FAILURE', payload: { code: 'OBSERVATION_UNAVAILABLE' }, emitter: 'SERVER' });
  r.clock.utcMs = r.armExpires() - 1; r.log.length = 0;
  assert.equal(await r.run.go(next), 'BLOCKED_PREVIOUS_TERMINAL_OBSERVATION_UNAVAILABLE', 'past the slot gate; no record before expiry is not yet a stop');
  assert.deepEqual(r.log, ['TERMINAL_OBSERVATION']);
  r.clock.utcMs = r.armExpires();
  assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_ARM_EXPIRED_UNUSED');
  assert.equal(r.run.armStop, 'ARM_EXPIRED_UNUSED'); r.log.length = 0;
  assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_ARM_EXPIRED_UNUSED', 'sticky'); assert.deepEqual(r.log, []);
});

test('arm phase: identity drift refuses before PRE; armIssued is durable before the ARM; a READY failure or a foreign READY_ACK after ARM_ACK ends I\'s pair', async () => {
  { const r = rig(); const id = r.prepare(); r.setHolds(false); r.log.length = 0;
    assert.equal(await r.run.go(id), 'BLOCKED_IDENTITY_DRIFT'); assert.deepEqual(r.log, []); assert.equal(r.session.nextCaseId, id, 'nothing consumed'); }
  for (const o of [{ readyDisposition: 'FAILED' as const }, { readyBoot: randomUUID() }]) {
    const r = rig(o); const id = r.prepare(); r.log.length = 0;
    assert.match(await r.run.go(id), /^ARM_FAILED_(ARM_UNAVAILABLE|PROTOCOL_INVALID)$/);
    const arm = r.log.indexOf('ARM_CASE');
    assert.ok(arm > 0 && r.log.slice(0, arm).includes('PERSIST armIssued=true armId=none'), `consumption + armIssued persisted before the ARM: ${r.log.join(',')}`);
    assert.ok(r.log.indexOf('END_PAIR') > arm, 'the armed pair is ended so no stray click can claim it');
    assert.deepEqual([r.run.armStop, r.session.state], ['ARM_PHASE_FAILURE', 'TERMINAL_INCOMPLETE']);
    assert.equal(r.receipt().cases[id].armIssued, true);
  }
});

test('rc3 N1: a COMMITTED handoff always gives RC5 the exact values — missing coverage or a fault withholds credit but never erases a proven failure', async () => {
  const MODEL = { kind: 'ERROR', code: 'ASK_REMOTE_MODEL_MISMATCH', settlement: 'RETAINED_KNOWN' };
  const MODEL_SETTLE = { state: 'UNKNOWN' as const, outcome: 'MODEL_MISMATCH', accounted: '300000' };
  const MODEL_PUB = { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code: 'ASK_REMOTE_MODEL_MISMATCH' };
  const row = async (mode: Mode, settle?: typeof MODEL_SETTLE, script?: Record<string, unknown>) => {
    const r = rig({ supportedFirst: true }); const { id, recorded } = await committedCase(r, mode, settle, script);
    return { r, id, recorded, facts: r.facts(), m: r.run.cases.get(id)!, effective: r.receipt().effective };
  };
  const control = await row({ final: true, publication: MODEL_PUB }, MODEL_SETTLE, MODEL);
  assert.equal(control.facts.state, 'TERMINAL_FAILED'); assert.ok(Object.keys(control.facts.safety).length > 0); assert.equal(control.facts.handoffFailures, 0);
  for (const mode of [{ final: true, publication: MODEL_PUB, fault: 'MODEL_OR_TIER_MISMATCH' }, { final: false }]) {
    const x = await row(mode, MODEL_SETTLE, MODEL);
    assert.deepEqual(x.facts, control.facts, `the public model/tier failure is kept: ${JSON.stringify(mode)}`);
    assert.equal(x.m.ledgerWithheld, false, 'an ERROR never earns credit: its measured ledger is kept');
    assert.equal(x.effective.state, 'TERMINAL_FAILED');
  }
  const TAMPER = (r: { id: string }) => ({ kind: 'INTENT', intent: corpus.cases.get(r.id)!.expectedIntent, tamper: 'OBSERVATION_SUMMARY' });
  const claims = async (mode: Mode) => { const r = rig({ supportedFirst: true }); const id = r.prepare();
    r.answerAndCommit(id, { outcome: 'USAGE_VERIFIED', accounted: '222' }, TAMPER({ id })); r.setMode(mode);
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED'); await r.run.finish();
    return { facts: r.facts(), m: r.run.cases.get(id)!, pass: r.casePass(id) }; };
  const claimsControl = await claims({ final: true });
  assert.equal(claimsControl.facts.state, 'TERMINAL_FAILED'); assert.ok(Object.keys(claimsControl.facts.safety).length > 0);
  const claimsUncovered = await claims({ final: false });
  assert.deepEqual([claimsUncovered.facts.state, claimsUncovered.facts.safety, claimsUncovered.facts.handoffFailures], ['TERMINAL_FAILED', claimsControl.facts.safety, 0],
    'a zero-tolerance claims failure stays FAILED and tallied without coverage');
  assert.deepEqual([claimsUncovered.m.creditBlock, claimsUncovered.m.ledgerWithheld, claimsUncovered.pass], ['TERMINAL_NOT_FINAL', true, false]);
  const valid = await row({ final: false });
  assert.deepEqual([valid.facts.state, valid.facts.handoffFailures, valid.m.ledgerWithheld, valid.r.casePass(valid.id)], ['TERMINAL_INCOMPLETE', 0, true, false],
    'a valid uncovered answer: no pass, no credit, liability unknown (accepted RC5 path), no false handoff failure');
});

test('rc3 N2/N3: POST snapshot checks, ARM_ACK echo, READY_ACK cap and the persist before GO each have a detecting test; the POST check keys to the case PRE tuple', async () => {
  for (const [over, admission] of [[{ consistent: false }, ADM], [{}, randomUUID()]] as const) {
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, { outcome: 'USAGE_VERIFIED', accounted: '222' }); r.setMode({ final: true });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
    r.control.handlers.SNAPSHOT = () => ({ kind: 'SNAPSHOT', payload: r.snapshotOf(over, admission), emitter: 'CONTROLLER' });
    await r.run.finish();
    assert.equal(r.run.cases.get(id)!.ledgerSource, 'UNAVAILABLE', `POST snapshot refused: ${JSON.stringify(over)}`); assert.equal(r.casePass(id), false);
  }
  { const r = rig(); const id = r.prepare(); r.answerAndCommit(id, { outcome: 'USAGE_VERIFIED', accounted: '222' }); r.setMode({ final: true });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /);
    assert.equal(r.run.confirm(ADM, V), 'BLOCKED', 'a confirm typed while a case is in flight clears the run tuple');
    assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED'); await r.run.finish();
    assert.deepEqual([r.run.cases.get(id)!.ledgerSource, r.casePass(id)], ['CONTROLLER_POST_SNAPSHOT', true], 'N3: the POST check uses the case PRE tuple'); }
  for (const armEcho of [{ fixtureId: 'FX01' }, { admissionId: randomUUID() }] as Record<string, string>[]) {
    const r = rig({ armEcho }); const id = r.prepare();
    assert.equal(await r.run.go(id), 'ARM_FAILED_PROTOCOL_INVALID', JSON.stringify(armEcho));
  }
  { const r = rig({ readyPad: true }); const id = r.prepare();
    assert.equal(await r.run.go(id), 'ARM_FAILED_FRAME_TOO_LARGE', 'READY_ACK over 4 KiB (the decoder alone would say PROTOCOL_INVALID)'); }
  { const r = rig(); const id = r.prepare(); r.log.length = 0;
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /);
    const ready = r.log.indexOf('READY');
    assert.ok(ready > 0 && r.log.slice(ready).includes('PERSIST armIssued=true armId=set'), `arm details persisted after READY_ACK, before the GO line: ${r.log.join(',')}`); }
});

test('RS-D-A census in the run: PRE before consumption, POST before the outcome; a mismatch blocks credit and stops arming; an extra submission is RC5 integrity; gap and epoch stop', async () => {
  const settle = { outcome: 'USAGE_VERIFIED', accounted: '222' };
  { // POST mismatch: a capability request during the case (foreign to the PRE→POST interval)
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, settle); r.setMode({ final: true });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /);
    r.censusExtra.capabilityIngressCount = 1n; r.censusExtra.physicalReleaseCount = 1n;
    assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
    assert.match(await r.run.finish(), new RegExp(`^CASE_RECORDED ${id} \\S+ COMMITTED NO_CREDIT_CENSUS_UNVERIFIED$`));
    const m = r.run.cases.get(id)!;
    assert.deepEqual([m.census, m.censusReason, r.run.armStop, m.ledgerWithheld, r.casePass(id)], ['CENSUS_MISMATCH', 'CAPABILITY', 'CENSUS_CHANGED_UNEXPECTEDLY', true, false]);
    assert.equal(r.receipt().effective.state, 'TERMINAL_INCOMPLETE');
    assert.equal(await r.run.go(nextAfter(id)), 'BLOCKED_ARM_STOPPED_CENSUS_CHANGED_UNEXPECTEDLY');
  }
  { // an extra submission during the case: RC5 duplicate-dispatch integrity failure of the consumed case
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, settle); r.setMode({ final: true });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); r.censusExtra.submitIngressCount = 1n;
    assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
    assert.match(await r.run.finish(), new RegExp(`^CASE_RECORDED ${id} INTEGRITY_DUPLICATE_SUBMISSION COMMITTED NO_CREDIT_CENSUS_UNVERIFIED$`));
    assert.deepEqual([r.run.cases.get(id)!.census, r.facts().state], ['EXTRA_ACTIVITY', 'TERMINAL_FAILED']);
  }
  { // between cases: a hidden reservation stops arming BEFORE the next case is consumed
    const r = rig(); const { id } = await committedCase(r, { final: true }); assert.equal(r.run.cases.get(id)!.census, 'MATCH');
    r.censusExtra.reservationConfirmedCount = 1n; const next = r.prepare(); r.log.length = 0;
    assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_CENSUS_CHANGED_UNEXPECTEDLY');
    assert.deepEqual([r.log.includes('SNAPSHOT'), r.log.includes('ARM_CASE'), r.session.nextCaseId], [false, false, next], 'nothing consumed');
    const rec = r.receipt();
    assert.deepEqual([rec.base.run.state, rec.effective], ['ACTIVE', { state: 'TERMINAL_INCOMPLETE', reason: 'CENSUS_UNVERIFIED' }],
      'RC5 cannot see the census stop; the stricter effective state records it');
  }
  { // another guard epoch (S restarted): the run's continuity is lost
    const r = rig(); await committedCase(r, { final: true }); r.setEpoch(randomUUID()); const next = r.prepare();
    assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST');
  }
  { // PRE census not idle or unavailable: refused before consumption, retryable
    const r = rig(); const id = r.prepare(); r.setActive(1);
    assert.equal(await r.run.go(id), 'BLOCKED_PRE_CENSUS_NOT_QUIESCENT'); assert.equal(r.run.armStop, null);
    const census = r.control.handlers.PROCESS_CENSUS!;
    r.control.handlers.PROCESS_CENSUS = () => ({ kind: 'FAILURE', payload: { code: 'OBSERVATION_UNAVAILABLE' }, emitter: 'CONTROLLER' });
    assert.equal(await r.run.go(id), 'BLOCKED_PRE_CENSUS_FAILURE_OBSERVATION_UNAVAILABLE');
    r.control.handlers.PROCESS_CENSUS = census; r.setActive(null);
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /, 'the same case GOes once the census is idle');
  }
});

test('receipt v4: census records, verdicts, drains and the executed order are allowlisted exactly (each tamper is RECEIPT_UNSAFE)', async () => {
  const r = rig(); const { id } = await committedCase(r, { final: true });
  const good = r.receipt(); assert.doesNotThrow(() => assertReceiptV6(good, CTX.cases));
  const drain = { snapshotId: randomUUID(), policyVersion: V, fenceEpoch: '7', registeredProcessCount: '1', reachableProcessCount: '1', pendingTaskCount: '0', pendingCommitCount: '0',
    physicalOwnerCount: '0', unmappedAttemptCount: '0', continuity: 'INTACT', state: 'QUIESCENT' };
  assert.doesNotThrow(() => assertReceiptV6({ ...good, drains: [{ afterCaseId: id, closurePolicyVersion: '9', closureFenceEpoch: '9', drain }] }, CTX.cases));
  const tampers: [string, (x: Record<string, any>) => void][] = [
    ['verdict with a reason', x => { x.cases[id].censusReason = 'SUBMIT'; }], ['mismatch without a reason', x => { x.cases[id].census = 'CENSUS_MISMATCH'; }],
    ['unknown verdict', x => { x.cases[id].census = 'OK'; }], ['census task items', x => { x.cases[id].postCensus.tasks = []; }],
    ['census gauge > 4', x => { x.cases[id].postCensus.activeTaskCount = '5'; }], ['census counter not Dec64', x => { x.cases[id].preCensus.submitIngressCount = 1; }],
    ['order digest', x => { x.order.sha256 = '0'.repeat(64); }], ['order rule', x => { x.order.rule = 'FROZEN'; }],
    ['frozen order digest', x => { x.order.frozenOrderSha256 = '0'.repeat(64); }],
    ['QUIESCENT drain with an owner', x => { x.drains = [{ afterCaseId: id, closurePolicyVersion: null, closureFenceEpoch: null, drain: { ...drain, physicalOwnerCount: '1' } }]; }],
    ['drain after an unknown case', x => { x.drains = [{ afterCaseId: 'RE-NOPE-999', closurePolicyVersion: null, closureFenceEpoch: null, drain }]; }],
    ['drain extra key', x => { x.drains = [{ afterCaseId: id, closurePolicyVersion: null, closureFenceEpoch: null, drain, note: 'x' }]; }],
    ['closure version without its fence', x => { x.drains = [{ afterCaseId: id, closurePolicyVersion: '9', closureFenceEpoch: null, drain }]; }],
    ['verdict without its POST record (rc2 N6)', x => { x.cases[id].postCensus = null; }],
    ['MATCH across two guard epochs (rc2 N6)', x => { x.cases[id].postCensus.guardEpoch = randomUUID(); }], ['candidate id', x => { x.revision.candidate.id = 'RS-C-C'; }]];
  for (const [name, tamper] of tampers) {
    const x = JSON.parse(JSON.stringify(good)); tamper(x);
    assert.throws(() => assertReceiptV6(x, CTX.cases), /RECEIPT_UNSAFE/, name);
  }
});

test('segment boundary in the run (D1/D2): after the whole FX07 segment the next GO needs the voluntary closure and a QUIESCENT DRAIN inside it', async () => {
  const r = rig(); let last = '';
  while (corpus.cases.get(r.session.nextCaseId!)!.fixtureId === 'FX07') last = (await committedCase(r, { final: true })).id;
  const next = r.session.nextCaseId!;
  assert.equal(corpus.cases.get(next)!.fixtureId, 'FX05');
  assert.equal(await r.run.go(next), 'BLOCKED_SEGMENT_CLOSURE_REQUIRED');
  assert.equal(r.session.voluntaryPause(), 'PAUSED_CLOSURE_PENDING');
  assert.equal(r.session.closure({ admissionId: ADM, paused: 'true', policyVersion: '8', fenceEpoch: '8' }), 'CONFIRMED');
  assert.equal(await r.run.go(next), 'BLOCKED_SEGMENT_DRAIN_REQUIRED');
  const drain = (over: Record<string, string> = {}) => ({ kind: 'DRAIN', emitter: 'CONTROLLER', payload: { snapshotId: randomUUID(), policyVersion: '8', fenceEpoch: '8',
    registeredProcessCount: '1', reachableProcessCount: '1', pendingTaskCount: '0', pendingCommitCount: '0', physicalOwnerCount: '0', unmappedAttemptCount: '0',
    continuity: 'INTACT', state: 'QUIESCENT', ...over } });
  r.control.handlers.DRAIN = () => drain({ state: 'PENDING', pendingTaskCount: '1', physicalOwnerCount: '1' });
  assert.match(await r.run.drain(), /^DRAIN PENDING /);
  assert.equal(await r.run.go(next), 'BLOCKED_SEGMENT_DRAIN_REQUIRED', 'a PENDING drain does not open the boundary');
  r.control.handlers.DRAIN = () => drain();
  assert.match(await r.run.drain(), /^DRAIN QUIESCENT INTACT /);
  assert.deepEqual(r.run.drains.map(e => [e.afterCaseId, e.closurePolicyVersion, e.drain.state]), [[last, '8', 'PENDING'], [last, '8', 'QUIESCENT']]);
  // The boundary is open: the GO proceeds past it (here to the PRE fixture check, as the owner has not switched the fixture yet).
  assert.equal(await r.run.go(next), 'BLOCKED_PRE_FIXTURE_OR_CENSUS');
  assert.equal(r.run.armStop, null);
  assert.doesNotThrow(() => assertReceiptV6(r.receipt(), CTX.cases));
});

test('rc2 review F1/F3/N2: a deferred EXTRA is RC5 integrity; C\'s continuity-loss answers are a persisted stop; a foreign attempt row between cases stops', async () => {
  const settle = { outcome: 'USAGE_VERIFIED', accounted: '222' };
  { // F1: the record is not FINAL at finish (POST deferred); an extra submission happened during the case
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, settle); r.setMode({ final: false });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); r.censusExtra.submitIngressCount = 1n;
    assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
    assert.match(await r.run.finish(), /NO_CREDIT_TERMINAL_NOT_FINAL$/);
    assert.equal(r.run.cases.get(id)!.census, null, 'deferred');
    r.setMode({ final: true });
    assert.equal(await r.run.go(nextAfter(id)), 'BLOCKED_ARM_STOPPED_CENSUS_CHANGED_UNEXPECTEDLY');
    assert.deepEqual([r.run.cases.get(id)!.census, r.facts().state], ['EXTRA_ACTIVITY', 'TERMINAL_FAILED'], 'the same classification as an immediate POST');
  }
  for (const code of ['IDENTITY_UNVERIFIED', 'IPC_LOST']) { // F3: C's real answers (CensusLink epoch rule; S unreachable)
    const r = rig(); const id = r.prepare(); r.log.length = 0;
    r.control.handlers.PROCESS_CENSUS = () => ({ kind: 'FAILURE', payload: { code }, emitter: 'CONTROLLER' });
    assert.equal(await r.run.go(id), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST', code);
    assert.ok(r.log.some(x => x.startsWith('PERSIST')), 'the stop is persisted');
    assert.deepEqual([r.receipt().effective, r.session.nextCaseId], [{ state: 'TERMINAL_INCOMPLETE', reason: 'CENSUS_UNVERIFIED' }, id], `${code}: nothing consumed`);
  }
  { // F3 on the deferred path
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, settle); r.setMode({ final: false });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED'); await r.run.finish();
    r.setMode({ final: true }); r.control.handlers.PROCESS_CENSUS = () => ({ kind: 'FAILURE', payload: { code: 'IPC_LOST' }, emitter: 'CONTROLLER' });
    assert.equal(await r.run.go(nextAfter(id)), 'BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST');
  }
  { // a retryable census failure stays a block
    const r = rig(); const id = r.prepare();
    r.control.handlers.PROCESS_CENSUS = () => ({ kind: 'FAILURE', payload: { code: 'CENSUS_UNAVAILABLE' }, emitter: 'SERVER' });
    assert.deepEqual([await r.run.go(id), r.run.armStop], ['BLOCKED_PRE_CENSUS_FAILURE_CENSUS_UNAVAILABLE', null]);
  }
  { // N2: an attempt row created between POST(k) and PRE(k+1) by something S never counted
    const r = rig(); await committedCase(r, { final: true });
    r.attempts.push({ correlationId: randomUUID(), state: 'SETTLED', outcome: 'NO_DISPATCH', accounted: '0' });
    const next = r.prepare(); r.log.length = 0;
    assert.equal(await r.run.go(next), 'BLOCKED_ARM_STOPPED_CENSUS_CHANGED_UNEXPECTEDLY');
    assert.deepEqual([r.log.includes('ARM_CASE'), r.session.nextCaseId], [false, next], 'stopped before consumption');
  }
});

test('RS-D-B proofs in the run and the receipt (v6); RS-D-A rc2-N1: a continuity loss at the immediate POST census is a persisted stop', async () => {
  const D = 'b'.repeat(64);
  const platform = { environmentId: randomUUID(), buildManifestSha256: D, serverBootId: randomUUID(), policyEvidenceRef: 'rsd-seatbelt-s-v2',
    destinationInventorySha256: D, intervalStart: iso(START), intervalEnd: iso(START + 1000), processCoverage: 'COMPLETE', destinationCoverage: 'UNKNOWN',
    unexpectedDestinationCount: '0', unknownDestinationCount: '0', unmeasuredProcessCount: '4', mode: 'MEASURED', countsAsVerifiedZero: false };
  const privacy = { environmentId: platform.environmentId, destinationInventorySha256: D, scannerManifestSha256: D, intervalStart: iso(START), intervalEnd: iso(START + 1000),
    coveredDestinationCount: '7', unreadableDestinationCount: '6', newUnclassifiedDestinationCount: '0', forbiddenContentMatchCount: '0', metadataViolationCount: '0',
    collectionState: 'DISABLED_AS_REQUIRED', externalRetentionEvidenceRef: null, mode: 'MEASURED', countsAsVerifiedZero: false };
  { const r = rig(); const { id } = await committedCase(r, { final: true });
    // rc2 N10: proofs are of THIS registration and S boot only (environmentId, serverBootId) — at take time and in the receipt.
    Object.assign(platform, { environmentId: r.control.binding.registrationId, serverBootId: r.control.binding.serverBootId, buildManifestSha256: BUILD });
    privacy.environmentId = r.control.binding.registrationId;
    r.control.handlers.PLATFORM_PROOF = () => ({ kind: 'PLATFORM_PROOF', payload: platform, emitter: 'CONTROLLER' });
    r.control.handlers.PRIVACY_PROOF = () => ({ kind: 'FAILURE', payload: { code: 'PRIVACY_UNVERIFIED' }, emitter: 'CONTROLLER' });
    assert.equal(await r.run.takeProofs(), 'PROOF_FAILED_PRIVACY_UNVERIFIED');
    for (const [p, q, why] of [[{ ...platform, serverBootId: randomUUID() }, privacy, 'another S boot'], [{ ...platform, environmentId: randomUUID() }, privacy, 'another registration'],
      [{ ...platform, buildManifestSha256: 'd'.repeat(64) }, privacy, 'another build than C identified (RS-D-C)'],
      [platform, { ...privacy, environmentId: randomUUID() }, 'a privacy proof of another registration']] as const) {
      r.control.handlers.PLATFORM_PROOF = () => ({ kind: 'PLATFORM_PROOF', payload: p, emitter: 'CONTROLLER' });
      r.control.handlers.PRIVACY_PROOF = () => ({ kind: 'PRIVACY_PROOF', payload: q, emitter: 'CONTROLLER' });
      assert.equal(await r.run.takeProofs(), 'PROOF_FAILED_PROTOCOL_INVALID', why);
    }
    assert.equal(r.run.proofs.length, 0, 'nothing recorded from a refused proof');
    r.control.handlers.PLATFORM_PROOF = () => ({ kind: 'PLATFORM_PROOF', payload: platform, emitter: 'CONTROLLER' });
    r.control.handlers.PRIVACY_PROOF = () => ({ kind: 'PRIVACY_PROOF', payload: privacy, emitter: 'CONTROLLER' });
    assert.match(await r.run.takeProofs(), /^PROOFS platform=rsd-seatbelt-s-v2 process=COMPLETE destinations=UNKNOWN verifiedZero=false privacy=DISABLED_AS_REQUIRED unreadable=6 matches=0 verifiedZero=false$/);
    const good = r.receipt();
    assert.deepEqual([good.schema, good.proofs.length, good.proofs[0].afterCaseId, good.flags], ['reval-instrument-receipt-v6', 1, id,
      { verifiedPass: false, liveAcceptanceEligible: false, liveAdmissionReadiness: 'BLOCKED' }], 'recorded only: no flag upgrade');
    for (const [name, tamper] of [['a forged verified zero', (x: Record<string, any>) => { x.proofs[0].platform.countsAsVerifiedZero = true; }],
      ['an unknown case', (x: Record<string, any>) => { x.proofs[0].afterCaseId = 'RE-NOPE-999'; }], ['an extra key', (x: Record<string, any>) => { x.proofs[0].note = 'x'; }],
      ['privacy with a match but verified', (x: Record<string, any>) => { x.proofs[0].privacy = { ...privacy, forbiddenContentMatchCount: '1', countsAsVerifiedZero: true }; }],
      ['a proof spliced from another S boot', (x: Record<string, any>) => { x.proofs[0].platform.serverBootId = randomUUID(); }],
      ['a privacy proof of another registration', (x: Record<string, any>) => { x.proofs[0].privacy.environmentId = randomUUID(); }],
      ['another receipt build (RS-D-C)', (x: Record<string, any>) => { x.build.buildManifestSha256 = 'd'.repeat(64); }],
      ['proofs without a build', (x: Record<string, any>) => { x.build = null; }], ['an extra build key', (x: Record<string, any>) => { x.build.note = 1; }]] as const) {
      const x = JSON.parse(JSON.stringify(good)); tamper(x);
      assert.throws(() => assertReceiptV6(x, CTX.cases), /RECEIPT_UNSAFE/, name);
    } }
  { // rc2-N1: the case's record is FINAL at finish, and C answers its POST census with S unreachable
    const r = rig(); const id = r.prepare(); r.answerAndCommit(id, { outcome: 'USAGE_VERIFIED', accounted: '222' }); r.setMode({ final: true });
    assert.match(await r.run.go(id), /^GO_CLICK_ASK_NOW /); assert.equal(await r.run.takeProofs(), 'BLOCKED_CASE_IN_FLIGHT');
    assert.equal(await r.run.handoff(), 'HANDOFF_COMMITTED');
    r.control.handlers.PROCESS_CENSUS = () => ({ kind: 'FAILURE', payload: { code: 'IPC_LOST' }, emitter: 'CONTROLLER' }); r.log.length = 0;
    assert.match(await r.run.finish(), /NO_CREDIT_CENSUS_UNVERIFIED$/);
    assert.deepEqual([r.run.armStop, r.run.cases.get(id)!.census, r.log.some(x => x.startsWith('PERSIST'))], ['CENSUS_CONTINUITY_LOST', null, true]);
  }
});
