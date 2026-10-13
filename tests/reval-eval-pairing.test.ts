import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ARM_WINDOW_MS, EvaluationState, PAIR_MAX_MS, sameSecret, SLOT_MS } from '../packages/reval/eval-state.ts';
import type { PairBinding } from '../packages/reval/eval-state.ts';
import { newToken } from '../packages/reval/eval-wire.ts';
import { TestClock } from './support/reval-eval-fixtures.ts';

// R-EVAL RS-C-A server pairing/arm/claim/slot state (rs-c brief §3; 04 "Pairing and arm", "First-current-GO bookkeeping" row S,
// "Memory, bounds and time"; rc2 review F2/F3/F5/F6/F12) with an injected clock and captured REAL-timer callbacks. Pure.
const REG = { registrationId: randomUUID(), serverBootId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor-reval' };
const ADMISSION = randomUUID();
/** TestClock whose scheduled timers are captured and run on demand (proves expiry without any getter access). */
class TimerClock extends TestClock {
  readonly due: { at: number; fn: () => void }[] = [];
  schedule = (ms: number, fn: () => void): void => { this.due.push({ at: this.mono() + ms, fn }); };
  runDue(): void { for (const t of this.due.splice(0)) if (t.at <= this.mono()) t.fn(); else this.due.push(t); }
}
const bound = (clock: TestClock, over: Partial<PairBinding> = {}): PairBinding => ({ credential: 'c'.repeat(64), admissionId: ADMISSION, policyVersion: '3',
  fixtureGeneration: '1', admissionExpiresMs: clock.wall() + 86_400_000, credentialExpiresMs: null, ...over });
function paired<C extends TestClock = TimerClock>(clock: C = new TimerClock() as unknown as C, over: Partial<PairBinding> = {}) {
  const s = new EvaluationState(REG, clock);
  const ids = { pairId: randomUUID(), control: randomUUID(), handoff: randomUUID(), nonce: newToken() };
  assert.deepEqual(s.install(ids.pairId, ids.control, ids.handoff, ids.nonce, clock.wall() + 120_000), { pairId: ids.pairId, expiresAt: new Date(clock.wall() + 120_000).toISOString(), paired: false });
  const p = s.browserPair(ids.nonce, bound(clock, over));
  assert.ok(typeof p !== 'string');
  return { s, clock, ids, session: p.sessionToken, pairExpiresAt: p.expiresAt };
}
const armInput = (pairId: string, caseId = `case-${randomUUID().slice(0, 8)}`) => ({ caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId: ADMISSION,
  policyVersion: '3', preSnapshotId: randomUUID(), browserPairId: pairId });
const current = (clock: TestClock, over: Record<string, unknown> = {}) => ({ fixtureId: 'FX02', fixtureGeneration: '1', admissionId: ADMISSION, policyVersion: '3',
  policyActive: true, admissionExpiresMs: clock.wall() + 86_400_000, priorCollected: true, ...over });
/** seeCase then armCase, as the runtime does. */
function arm(s: EvaluationState, input: ReturnType<typeof armInput>, facts: ReturnType<typeof current>) { return s.seeCase(input.caseId) ?? s.armCase(input, facts); }
/** A paired state with one READY arm claimed and its slot AVAILABLE with raw values (as after a published answer). */
function available() {
  const x = paired(new TimerClock()); const a = arm(x.s, armInput(x.ids.pairId), current(x.clock)); assert.ok(typeof a !== 'string');
  assert.equal(x.s.ready(x.ids.handoff, a.armId, '1', randomUUID()), null);
  assert.ok(x.s.claim(x.session));
  const slot = x.s.slot!; slot.request = { q: 1 }; slot.publication = { status: 200, correlationId: randomUUID(), body: {} }; slot.receiptNonce = newToken(); slot.state = 'AVAILABLE';
  return { ...x, a };
}

test('PAIR install: one pair per server, nonce ≤120 s; browser PAIR one-use, ≤10 min, ≤ admission AND credential expiry', () => {
  const clock = new TimerClock(); const s = new EvaluationState(REG, clock);
  assert.equal(s.install(randomUUID(), randomUUID(), randomUUID(), newToken(), clock.wall() + 120_001), 'PAIR_EXPIRED');
  assert.equal(s.install(randomUUID(), randomUUID(), randomUUID(), newToken(), clock.wall()), 'PAIR_EXPIRED');
  const nonce = newToken();
  assert.ok(typeof s.install(randomUUID(), randomUUID(), randomUUID(), nonce, clock.wall() + 60_000) !== 'string');
  assert.equal(s.install(randomUUID(), randomUUID(), randomUUID(), newToken(), clock.wall() + 60_000), 'PAIR_UNAVAILABLE', 'occupied');
  assert.equal(s.browserPair(newToken(), bound(clock)), 'PAIR_UNAVAILABLE', 'wrong nonce');
  const p = s.browserPair(nonce, bound(clock));
  assert.ok(typeof p !== 'string' && p.expiresAt === new Date(clock.wall() + PAIR_MAX_MS).toISOString());
  assert.equal(s.browserPair(nonce, bound(clock)), 'PAIR_UNAVAILABLE', 'the nonce is one-use');
  assert.ok(s.pairCredential('c'.repeat(64)) && !s.pairCredential('d'.repeat(64)), 'bound to its pairing credential');
  const adm = paired(new TimerClock(), { admissionExpiresMs: new TestClock().wall() + 30_000 });
  assert.equal(adm.pairExpiresAt, new Date(adm.clock.wall() + 30_000).toISOString());
  const cred = paired(new TimerClock(), { credentialExpiresMs: new TestClock().wall() + 20_000 });
  assert.equal(cred.pairExpiresAt, new Date(cred.clock.wall() + 20_000).toISOString(), 'the pairing credential caps the pair');
  // An expired nonce revokes the reserved pair — by the real timer, without any access in between.
  const c2 = new TimerClock(); const s2 = new EvaluationState(REG, c2); const n2 = newToken();
  s2.install(randomUUID(), randomUUID(), randomUUID(), n2, c2.wall() + 1000); c2.advance(1000); c2.runDue();
  assert.equal(s2.browserPair(n2, bound(c2)), 'PAIR_UNAVAILABLE');
  assert.ok(sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('abc', null) && !sameSecret('ab', 'abc'));
});

test('ARM (row S): seeCase BEFORE every check; armCase needs a seen case; exact facts; ≤1 arm; window caps', () => {
  const { s, clock, ids } = paired();
  const a = armInput(ids.pairId, 'case-a');
  assert.equal(s.armCase(a, current(clock)), 'PROTOCOL_INVALID', 'never armed unless seen first');
  assert.equal(arm(s, { ...a, browserPairId: randomUUID() }, current(clock)), 'PAIR_UNAVAILABLE');
  assert.equal(arm(s, a, current(clock)), 'CASE_CONSUMED', 'the failed first use consumed it');
  for (const [over, code] of [[{ priorCollected: false }, 'OBSERVATION_GAP'], [{ fixtureId: 'FX03' }, 'FIXTURE_MISMATCH'], [{ admissionExpiresMs: clock.wall() }, 'ARM_EXPIRED']] as const) {
    assert.equal(arm(s, armInput(ids.pairId), current(clock, over)), code);
  }
  assert.equal(arm(s, { ...armInput(ids.pairId), policyVersion: '2' }, current(clock)), 'POLICY_CHANGED', 'a stale request tuple refuses');
  assert.equal(s.pair?.state, 'PAIRED', 'a stale request does not revoke the pair');
  const ok = arm(s, armInput(ids.pairId, 'case-ok'), current(clock));
  assert.ok(typeof ok !== 'string' && ok.expiresAt === new Date(clock.wall() + ARM_WINDOW_MS).toISOString());
  assert.equal(arm(s, armInput(ids.pairId), current(clock)), 'ARM_UNAVAILABLE', 'one active arm');
  const late = paired(Object.assign(new TimerClock(), { wall0: Date.parse('2026-10-11T23:59:50.000Z') }));
  const capped = arm(late.s, armInput(late.ids.pairId), current(late.clock));
  assert.ok(typeof capped !== 'string' && capped.expiresAt === '2026-10-12T00:00:00.000Z');
});

test('rc2 F6: a non-ACTIVE policy, another admission/policy version or fixture generation than the pair was bound to REVOKES the pair', () => {
  for (const [over, code] of [[{ policyActive: false }, 'ADMISSION_NOT_ACTIVE'], [{ policyVersion: '4' }, 'POLICY_CHANGED'], [{ admissionId: randomUUID() }, 'POLICY_CHANGED'],
    [{ fixtureGeneration: '2' }, 'FIXTURE_MISMATCH']] as const) {
    const x = paired();
    assert.equal(arm(x.s, armInput(x.ids.pairId), current(x.clock, over)), code);
    assert.ok(x.s.pair?.state === 'ENDED' && !x.s.isSessionToken(x.session), `${code} revokes the pair`);
  }
});

test('READY then claim: exact handoff connection, never renews; one claim takes the arm\'s OWN READY; expiry/revocation never re-arm', () => {
  const { s, clock, ids, session } = paired();
  const ack = arm(s, armInput(ids.pairId), current(clock));
  assert.ok(typeof ack !== 'string');
  assert.equal(s.claim(session), null, 'ARMED is not claimable before READY');
  assert.equal(s.ready(randomUUID(), ack.armId, '1', randomUUID()), 'PAIR_UNAVAILABLE');
  assert.equal(s.ready(ids.handoff, randomUUID(), '1', randomUUID()), 'ARM_UNAVAILABLE');
  const challenge = randomUUID();
  assert.equal(s.ready(ids.handoff, ack.armId, '7', challenge), null);
  assert.equal(s.ready(ids.handoff, ack.armId, '8', randomUUID()), 'ARM_UNAVAILABLE', 'READY once');
  assert.equal(s.claim(newToken()), null, 'foreign token');
  const c = s.claim(session);
  assert.ok(c && c.armId === ack.armId && s.slot?.state === 'BOUND' && s.counters.claimed === 1);
  assert.deepEqual(s.slot?.ready, { sequence: '7', challenge }, 'the slot keeps its own arm READY');
  assert.equal(s.claim(session), null, 'one claim');
  const e = paired(); const a2 = arm(e.s, armInput(e.ids.pairId), current(e.clock)); assert.ok(typeof a2 !== 'string');
  e.clock.advance(ARM_WINDOW_MS);
  assert.equal(e.s.ready(e.ids.handoff, a2.armId, '1', randomUUID()), 'ARM_EXPIRED');
  const r = paired(); const a3 = arm(r.s, armInput(r.ids.pairId), current(r.clock)); assert.ok(typeof a3 !== 'string');
  r.s.ready(r.ids.handoff, a3.armId, '1', randomUUID());
  assert.deepEqual(r.s.endPair(r.ids.pairId), { pairId: r.ids.pairId, expiresAt: r.pairExpiresAt, paired: false });
  assert.ok(r.s.arm?.state === 'REVOKED' && r.s.claim(r.session) === null && !r.s.isSessionToken(r.session));
});

test('rc2 F3: no new arm while the publication slot is live (AVAILABLE/CLAIMED/in transfer); after COMMITTED or BURNED it may', () => {
  for (const live of ['AVAILABLE', 'CLAIMED', 'TRANSFER_SENT', 'ACK_VALIDATED'] as const) {
    const x = available(); x.s.finishArm(x.a.armId); x.s.slot!.state = live;
    assert.equal(arm(x.s, armInput(x.ids.pairId), current(x.clock)), 'ARM_UNAVAILABLE', live);
  }
  const done = available(); done.s.finishArm(done.a.armId); done.s.burnSlot();
  assert.ok(typeof arm(done.s, armInput(done.ids.pairId), current(done.clock)) !== 'string', 'a BURNED slot does not block');
});

test('rc2 F5: the slot\'s raw values drop at 120 s by the REAL timer, without any later access; revocation drops them at once', () => {
  const x = available();
  x.clock.advance(SLOT_MS - 1); x.clock.runDue();
  assert.ok(x.s.rawRetained(), 'still inside the 120 s bound');
  x.clock.advance(1); x.clock.runDue();
  assert.equal(x.s.rawRetained(), false, 'dropped by the timer');
  const y = available(); y.s.endPair(y.ids.pairId);
  assert.equal(y.s.rawRetained(), false);
});
