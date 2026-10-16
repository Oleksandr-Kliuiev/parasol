import { loadContext, verifyTestArtifact } from './support/reval-history.ts';
import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS } from '../scripts/ask-remote-eval/dataset.ts';
import { ADMIN_OVERLAYS, ADMIN_PATHS, adminOverlaySha256, overlayDrift, sameIdentity, verifyArtifact } from '../scripts/ask-remote-eval-execution/artifact.ts';
import { fakeRequest } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { buildReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { ADMISSION_ID, advance, playNext, playUntil, rig, runScenarios, SCENARIOS } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import { ExecutionSession } from '../scripts/ask-remote-eval-execution/session.ts';
import { ExecError } from '../scripts/ask-remote-eval-execution/validate.ts';

// R-EVAL execution instrument (SIMULATED fake V2 only): the accepted supervisor model wrapped with transient V2 validation,
// independent truth comparison for the OBSERVED intent, attested ledger/closure inputs, consent challenge, artifact checks
// and the safe receipt. No live run, provider, DB or network.

const ctx = loadContext();
const caseOf = (id: string) => ctx.corpus.cases.get(id)!;
const focusOf = (id: string) => ctx.corpus.fixtures.get(caseOf(id).fixtureId)!.spec.requestedFocus;

test('artifact identity verifies against both pinned accepted manifests and binds dataset/fixture/order', () => {
  const s = verifyTestArtifact();
  assert.equal(s.ok, true); assert.deepEqual(s.drift, []);
  assert.equal(s.identity!.offlinePackageHash, 'd706a437b2e77ccb215080d4676d2ae70fee53376636d3d9040590d5d8f2dc3a');
  assert.equal(s.identity!.rcPackageHash, '9ae0c2b813388af58ee7d12e4df7f59521ba8cff417a4124ea9ddb2bff1c7fe1');
  assert.equal(s.identity!.orderSha256, '9deaa3c5c1277bdc5eb74f892909a2aca9d0756538432def5d0e9202b0504a5d');
  assert.equal(s.labelStatus, 'DRAFT_MODEL_ASSISTED');
  assert.ok(s.filesChecked > 1500);
  assert.equal(sameIdentity(s, { ...s, identity: { ...s.identity!, fixtureSha256: '0'.repeat(64) } }), false);
  assert.equal(ctx.corpus.order.length, 200);
});

test('administrative overlays are frozen at exact pinned hashes: any other bytes are drift, never adopted', () => {
  assert.deepEqual([...ADMIN_PATHS], ['AGENTS.md', 'docs/AI_CONTEXT_MAP.md', 'docs/DEVELOPMENT_WORKFLOW.md', 'docs/stage5/IMPLEMENTATION_STATUS.md',
    'docs/stage5/REVIEW_STATUS.md', 'docs/stage5/ask/remote/DESIGN_STATUS.md']);
  for (const h of Object.values(ADMIN_OVERLAYS)) assert.match(h, /^[0-9a-f]{64}$/);
  // Pure comparator with injected actual hashes (no repository file is touched).
  const exact = (p: string): string | null => ADMIN_OVERLAYS[p] ?? null;
  assert.deepEqual(overlayDrift(ADMIN_OVERLAYS, exact), []);
  assert.deepEqual(overlayDrift(ADMIN_OVERLAYS, p => p === 'docs/AI_CONTEXT_MAP.md' ? 'f'.repeat(64) : exact(p)), ['docs/AI_CONTEXT_MAP.md']);
  assert.deepEqual(overlayDrift(ADMIN_OVERLAYS, p => p === 'AGENTS.md' ? null : exact(p)), ['AGENTS.md']);
  assert.deepEqual(overlayDrift(ADMIN_OVERLAYS, () => 'f'.repeat(64)), [...ADMIN_PATHS].sort());
  // The identity digest is of the PINNED table: a changed table changes it; disk is verified against the table, never sampled.
  const s = verifyTestArtifact();
  assert.equal(s.ok, true); assert.ok(!s.drift.includes('ADMIN_OVERLAY_DRIFT'));
  assert.equal(s.identity!.adminOverlaySha256, adminOverlaySha256());
  assert.notEqual(adminOverlaySha256({ ...ADMIN_OVERLAYS, 'AGENTS.md': '0'.repeat(64) }), adminOverlaySha256());
  assert.equal(sameIdentity(s, { ...s, identity: { ...s.identity!, adminOverlaySha256: '0'.repeat(64) } }), false);
  for (const p of s.adminDeltaPaths) assert.ok(ADMIN_PATHS.includes(p));
});

test('every plan-derived rehearsal scenario reaches its expected state', () => {
  const results = runScenarios(ctx);
  assert.equal(results.length, SCENARIOS.length);
  for (const r of results) assert.equal(r.pass, true, `${r.id}: ${JSON.stringify(r.observed)}`);
});

test('a grounded wrong intent is judged against the OBSERVED intent projection: semantic fail, never a safety hit', () => {
  const r = rig(ctx); playUntil(r, c => c.group === 'SUPPORTED_WHY_URGENT');
  const id = r.session.nextCaseId!;
  playNext(r, { script: () => ({ kind: 'INTENT', intent: 'SUMMARY' }) });
  const rec = (r.session.facts().report.records as Record<string, unknown>[]).find(x => x.caseId === id)!;
  assert.equal(rec.semantic, 'MISMATCH'); assert.equal(rec.casePass, false);
  assert.deepEqual(r.session.facts().evidence.get(id)!.truth, { claims: true, coverage: true, urgency: true, schema: true });
  assert.equal(r.session.state, 'ACTIVE');
});

test('consumption: a blocked preflight consumes nothing; a repeated submission is a permanent integrity failure', () => {
  const r = rig(ctx); const id = r.session.nextCaseId!;
  r.fake.revise();
  assert.equal(playNext(r), 'preflight:BLOCKED_VERSION_CHANGED');
  assert.equal(r.session.facts().report.consumed, 0);
  r.session.confirmTuple(ADMISSION_ID, r.fake.tuple.policyVersion);
  playNext(r);
  assert.equal(r.session.facts().report.consumed, 1);
  assert.equal(r.session.submit(id), 'INTEGRITY_DUPLICATE_SUBMISSION');
  assert.equal(r.session.state, 'TERMINAL_FAILED');
  r.session.closure(r.fake.pause());
  assert.equal(r.session.state, 'TERMINAL_FAILED', 'terminal states absorb');
  assert.equal(r.session.resumeDay(), 'RESUME_DENIED_STATE');
});

test('invalid transient input throws a fixed code, records nothing and leaves the case in flight', () => {
  const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = caseOf(id);
  s.counters(r.fake.counters(r.clock.utcMs)); s.capability(r.fake.capability().http);
  s.stage(id, focusOf(id) ?? 'none', c.question); s.consent(id, s.consentChallenge(id), true);
  const tuple = r.fake.tuple;
  assert.equal(s.submit(id), 'DISPATCH');
  const request = fakeRequest('t1', c.question, focusOf(id), tuple);
  const reply = r.fake.ask(request, c.fixtureId, { kind: 'INTENT', intent: c.expectedIntent }, r.clock.utcMs);
  assert.equal(s.outcome(id, { request, reply: reply.http, ledger: null }), 'BLOCKED_NOT_ARRIVED');
  advance(r, 800); s.arrived(id);
  const hostile = `<script>${c.question}</script>`;
  for (const bad of [hostile, '{"a":1,"a":2}', 'x'.repeat(300_000)]) {
    assert.throws(() => s.outcome(id, { request: bad, reply: reply.http, ledger: null }), (e: unknown) => e instanceof ExecError && e.code === 'PASTE_REJECTED'
      && !e.message.includes('script') && !e.message.includes(c.question));
  }
  assert.throws(() => s.outcome(id, { request, reply: reply.http, ledger: { ...r.fake.ledgerFor(reply.correlationId)!, attempts: '0' } }),
    (e: unknown) => e instanceof ExecError && e.code === 'LEDGER_INVALID');
  assert.equal(s.inFlight, id);
  assert.equal(s.outcome(id, { request, reply: reply.http, ledger: r.fake.ledgerFor(reply.correlationId) }), 'ACTIVE');
  assert.equal(s.inFlight, null);
  assert.equal(s.facts().evidence.get(id)!.reconciliation, 'RECONCILED');
});

test('pre-submission gate: text/focus mismatch blocks and consumes nothing; consent needs the fresh challenge AND explicit true', () => {
  const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = caseOf(id);
  assert.equal(s.stage(id, focusOf(id) ?? 'none', c.question.toUpperCase() === c.question ? `${c.question}.` : c.question.toUpperCase()), 'BLOCKED_TEXT_MISMATCH');
  assert.throws(() => s.consentChallenge(id), (e: unknown) => e instanceof ExecError && e.code === 'CONSENT_NOT_AVAILABLE');
  assert.equal(s.stage(id, focusOf(id) ?? 'none', c.question), 'STAGED');
  const nonce = s.consentChallenge(id);
  assert.equal(s.consent(id, nonce, 'true'), 'BLOCKED');
  assert.equal(s.consent(id, nonce, true), 'BLOCKED', 'a challenge is one-use');
  assert.equal(s.consent(id, s.consentChallenge(id), true), 'CONSENTED');
  assert.equal(s.facts().report.consumed, 0);
  assert.throws(() => s.stage('RE-XYZ-001', 'none', c.question), (e: unknown) => e instanceof ExecError && e.code === 'CASE_ID_INVALID');
  assert.throws(() => s.stage(id, 'syn-obs-‮', c.question), (e: unknown) => e instanceof ExecError && e.code === 'FOCUS_ID_INVALID');
});

test('numeric/version metadata fails closed with fixed codes', () => {
  const r = rig(ctx); const s = r.session;
  for (const v of ['01', '1e3', '-1', '1.0', ' 1', '9223372036854775808', '']) {
    assert.throws(() => s.confirmTuple(ADMISSION_ID, v), (e: unknown) => e instanceof ExecError && e.code === 'POLICY_VERSION_INVALID');
  }
  assert.throws(() => s.confirmTuple('5E1F7A2B-3C4D-4E5F-8A6B-7C8D9E0F1A2B', '8'), (e: unknown) => e instanceof ExecError && e.code === 'ADMISSION_ID_INVALID');
  for (const [day, month] of [['-5', '0'], ['5', '4'], ['1.5', '9'], ['2000001', '2000001'], ['0x10', '20']]) {
    assert.throws(() => s.counters({ dayChargedMicro: day!, monthChargedMicro: month! }), (e: unknown) => e instanceof ExecError);
  }
  assert.equal(s.confirmTuple(ADMISSION_ID, '6'), 'BLOCKED', 'never below the highest observed version');
});

test('admission values are validated: crossing a UTC month, oversized caps or pacing above 10 refuse', () => {
  const base = { admissionId: ADMISSION_ID, startUtc: '2026-10-28T00:00:00Z', expiryUtc: '2026-10-30T00:00:00Z', dayCapMicro: '2000000',
    monthCapMicro: '10000000', openingFenceEpoch: '40', pacingMax: '10' };
  const deps = { runClass: 'OFFLINE_FAKE_V2_REHEARSAL' as const, clock: () => ({ utcMs: 0, monoMs: 0 }), verify: () => ctx.snapshot, nonce: () => 'n', corpus: ctx.corpus };
  assert.doesNotThrow(() => new ExecutionSession(deps, base));
  for (const [patch, code] of [[{ expiryUtc: '2026-11-02T00:00:00Z' }, 'ADMISSION_INVALID'], [{ dayCapMicro: '2000001' }, 'ADMISSION_INVALID'],
    [{ pacingMax: '11' }, 'PACING_INVALID'], [{ startUtc: '2026-02-30T00:00:00Z' }, 'ADMISSION_START_INVALID'], [{ openingFenceEpoch: '0' }, 'OPENING_FENCE_INVALID']] as const) {
    assert.throws(() => new ExecutionSession(deps, { ...base, ...patch }), (e: unknown) => e instanceof ExecError && e.code === code, code);
  }
  assert.throws(() => new ExecutionSession({ ...deps, verify: () => ({ ...ctx.snapshot, ok: false }) }, base), (e: unknown) => e instanceof ExecError && e.code === 'ARTIFACT_IDENTITY_NOT_VERIFIED');
});

test('latency: monotonic submit→arrived, nearest-rank with explicit n, timeouts censored separately, denominator 200', () => {
  const r = rig(ctx);
  playNext(r, { latencyMs: 400 }); playNext(r, { latencyMs: 1600 });
  playNext(r, { script: () => ({ kind: 'TIMEOUT' }), latencyMs: 10_000 });
  const receipt = buildReceipt(r.session, ctx.cases) as { latency: Record<string, any>; cases: Record<string, unknown>[] };
  assert.deepEqual(receipt.latency.answered, { n: 2, p50: 400, p95: 1600, max: 1600 });
  assert.equal(receipt.latency.censored, 1); assert.equal(receipt.latency.denominator, 200);
  assert.equal(receipt.cases.at(-1)!.durationMs, null); assert.equal(receipt.cases.at(-1)!.censored, true);
});

test('receipt never carries an observed/expected intent value, question, rationale or pasted body', () => {
  const r = rig(ctx);
  playNext(r, { script: () => ({ kind: 'INTENT', intent: 'ENTITY' }) });
  for (let i = 0; i < 5; i += 1) playNext(r);
  const receipt = buildReceipt(r.session, ctx.cases);
  const strings: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(receipt);
  assert.equal(strings.filter(s => (INTENTS as readonly string[]).includes(s)).length, 0);
  const text = JSON.stringify(receipt);
  for (const c of ctx.cases) { assert.ok(!text.includes(c.question.slice(0, 40))); assert.ok(!text.includes(c.rationale)); }
  assert.ok(!/"(question|answer|body|request|observedIntent|expectedIntent|rationale)"/.test(text));
  assert.equal((receipt as { liveAcceptanceEligible: boolean }).liveAcceptanceEligible, false);
});
