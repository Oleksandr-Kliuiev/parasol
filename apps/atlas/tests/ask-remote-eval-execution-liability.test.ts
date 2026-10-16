import { loadContext } from './support/reval-history.ts';
import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvalCase } from '../scripts/ask-remote-eval/dataset.ts';
import type { FakeScript } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { buildReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { CONTRADICT, observe, OTHER, playNext, playUntil, rig, UNRECONCILE } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import type { Play } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import { replayNumeric } from '../scripts/ask-remote-eval-execution/replay.ts';

// RC3 additional P2 regression matrix (SIMULATED fake V2): every unknown-liability accounting path × every proof class.
// Priority: a validated truth failure → FAILED; a certain failure that makes a threshold unreachable → FAILED; otherwise
// INCOMPLETE. In EVERY unknown-liability path the answer gets no pass and no validated-provider credit; the semantic
// MATCH/MISMATCH and truth booleans are kept; the reserve stays retained (unknown or explicitly retained), never refunded.

const ctx = loadContext();
const supported = (c: EvalCase): boolean => c.group.startsWith('SUPPORTED_');
const hasObservation = (c: EvalCase): boolean => ctx.corpus.fixtures.get(c.fixtureId)!.spec.expected.bank.some(id => id.startsWith('O:'));
type Mode = 'MISSING' | 'UNBOUND' | 'UNRECONCILED' | 'CONTRADICTION' | 'EXPLICIT_UNKNOWN';
const MODES: readonly Mode[] = ['MISSING', 'UNBOUND', 'UNRECONCILED', 'CONTRADICTION', 'EXPLICIT_UNKNOWN'];
/** Ledger side of the final case for each mode (EXPLICIT_UNKNOWN: a consistent, reconciled RETAINED_UNKNOWN_COMMIT read). */
function withMode(mode: Mode, script: (c: EvalCase) => FakeScript): Play {
  if (mode === 'MISSING') return { script, ledger: 'MISSING' };
  if (mode === 'UNBOUND') return { script, ledger: 'WRONG_CORRELATION' };
  if (mode === 'UNRECONCILED') return { script, ledgerFn: UNRECONCILE };
  if (mode === 'CONTRADICTION') return { script, ledgerFn: CONTRADICT };
  return { script: c => ({ ...script(c), settlement: 'RETAINED_UNKNOWN_COMMIT' }) as FakeScript };
}
const answer = (intent: (c: EvalCase) => string, tamper?: 'OBSERVATION_SUMMARY') => (c: EvalCase): FakeScript =>
  ({ kind: 'INTENT', intent: intent(c), ...(tamper ? { tamper } : {}) }) as FakeScript;
const KINDS = {
  GROUNDED_MATCH: { setup: (_r: ReturnType<typeof rig>) => undefined, script: answer(c => c.expectedIntent), expect: 'INCOMPLETE', semantic: 'MATCH' },
  REFUSAL_MISMATCH: { setup: (r: ReturnType<typeof rig>) => playUntil(r, c => !supported(c)), script: answer(() => 'SUMMARY'), expect: 'THRESHOLD', semantic: 'MISMATCH' },
  TRUTH_FAILURE: { setup: (r: ReturnType<typeof rig>) => playUntil(r, hasObservation), script: answer(c => c.expectedIntent, 'OBSERVATION_SUMMARY'), expect: 'SAFETY', semantic: 'MATCH' },
  FIRST_SUPPORTED_MISMATCH: { setup: (r: ReturnType<typeof rig>) => playUntil(r, supported), script: answer(c => OTHER[c.expectedIntent]!), expect: 'INCOMPLETE', semantic: 'MISMATCH' },
  SECOND_SUPPORTED_MISMATCH: { setup: (r: ReturnType<typeof rig>) => {
    playUntil(r, supported); const group = ctx.corpus.cases.get(r.session.nextCaseId!)!.group;
    playNext(r, { script: answer(c => OTHER[c.expectedIntent]!) }); assert.equal(r.session.state, 'ACTIVE', 'first supported miss with known accounting continues');
    playUntil(r, c => c.group === group);
  }, script: answer(c => OTHER[c.expectedIntent]!), expect: 'THRESHOLD', semantic: 'MISMATCH' }
} as const;

for (const mode of MODES) {
  for (const [kind, k] of Object.entries(KINDS)) {
    test(`unknown liability ${mode} × ${kind}: proof-based priority, no credit, evidence kept`, () => {
      const r = rig(ctx); k.setup(r);
      const before = r.session.facts();
      const creditedBefore = before.report.validatedAnswers as number; const unknownBefore = before.totals.unknownLiabilityCases;
      const retainedBefore = before.totals.retainedReserveMicro;
      playNext(r, withMode(mode, k.script));
      const o = observe(r); const f = r.session.facts();
      const contradiction = mode === 'CONTRADICTION';
      const expectedReason = k.expect === 'SAFETY' ? (contradiction ? 'SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER' : 'SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY')
        : k.expect === 'THRESHOLD' ? (contradiction ? 'THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER' : 'THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY')
          : (contradiction ? 'LEDGER_REPLY_CONTRADICTION' : 'ANSWER_LIABILITY_UNKNOWN');
      assert.equal(o.state, k.expect === 'INCOMPLETE' ? 'TERMINAL_INCOMPLETE' : 'TERMINAL_FAILED');
      assert.equal(o.localReason, expectedReason);
      assert.equal(o.lastPass, false, 'no case pass');
      assert.equal(o.validatedAnswers, creditedBefore, 'no validated-provider credit');
      assert.equal(o.lastSemantic, k.semantic, 'semantic kept independent of credit');
      assert.deepEqual(o.safety, k.expect === 'SAFETY' ? { CLAIMS: 1 } : {}, 'truth evidence never lost');
      if (mode === 'EXPLICIT_UNKNOWN') {
        assert.equal(f.totals.retainedReserveMicro, retainedBefore + 300_000, 'explicitly unknown commit keeps the FULL reserve in the floor');
        assert.equal(f.totals.unknownLiabilityCases, unknownBefore);
      } else assert.equal(f.totals.unknownLiabilityCases, unknownBefore + 1);
      const receipt = buildReceipt(r.session, ctx.cases) as Record<string, any>;
      const last = receipt.cases.at(-1);
      assert.equal(last.outcome, contradiction ? 'LEDGER_REPLY_CONTRADICTION' : 'ANSWER_LIABILITY_UNKNOWN');
      assert.equal(last.casePass, false); assert.equal(last.semantic, k.semantic); assert.notEqual(last.truth, null);
      assert.equal(last.liability, 'RETAINED_UNKNOWN_COMMIT');
      assert.equal(receipt.run.validatedAnswers, creditedBefore);
      assert.equal(replayNumeric(receipt).status, 'VERIFIED_SAVED_ARITHMETIC');
      assert.ok(!JSON.stringify(receipt).includes('"observedIntent"'));
    });
  }
}

test('known, reconciled accounting is unchanged: a grounded match passes and is credited', () => {
  const r = rig(ctx); playNext(r);
  const o = observe(r);
  assert.equal(o.state, 'ACTIVE'); assert.equal(o.lastPass, true); assert.equal(o.validatedAnswers, 1); assert.equal(o.localReason, null);
});

test('numeric replay rejects a receipt that credits an unknown-liability answer', () => {
  const r = rig(ctx); playNext(r); playNext(r, { ledgerFn: UNRECONCILE });
  const receipt = buildReceipt(r.session, ctx.cases) as Record<string, any>;
  assert.equal(replayNumeric(receipt).status, 'VERIFIED_SAVED_ARITHMETIC');
  const forged = JSON.parse(JSON.stringify(receipt)); const last = forged.cases.at(-1);
  last.outcome = 'ANSWER'; last.casePass = true; forged.run.validatedAnswers += 1;
  assert.ok(replayNumeric(forged).failed.includes('UNKNOWN_LIABILITY_CREDITED'));
  const passOnly = JSON.parse(JSON.stringify(receipt)); passOnly.cases.at(-1).casePass = true;
  assert.ok(replayNumeric(passOnly).failed.includes('UNCREDITED_PASS'));
  const count = JSON.parse(JSON.stringify(receipt)); count.run.validatedAnswers += 1;
  assert.ok(replayNumeric(count).failed.includes('VALIDATED_ANSWER_COUNT'));
});
