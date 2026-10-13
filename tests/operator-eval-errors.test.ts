import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { askError } from './support/operator-ask.ts';
import { ASK, HANDOFF, TOKEN_A, answered, askNow, evalHarness, focusOf, json, newToken, pair200, paired, readyConsole, settle } from './support/operator-eval.ts';
import type { EvalHarness } from './support/operator-eval.ts';

// RS-C-C rc2 (review rc1 F2/F3/F4): the measured pane applies the accepted current-generation error rules to its own completions (04
// "Current matching completion … apply existing current-generation error rules"; 03 "401 disconnects", "every current 403 resets the
// scope"; apps/operator/AGENTS.md current 409 ASK_REMOTE_POLICY_CHANGED), keeps an eligible handoff through a local refusal, ends the
// pair on every RESPONSE refusal for which the server revoked it, keeps refusal codes visible, and ignores ALREADY-RESOLVED stale values
// (AbortController.abort disabled, so the late value really reaches the completion handler). Synthetic values only.
const ui = (h: EvalHarness) => h.evaluation.state();
async function withoutAbort(body: () => Promise<void>): Promise<void> {
  const original = AbortController.prototype.abort;
  AbortController.prototype.abort = function ignored() { /* never delivered: the late value reaches the handler */ };
  try { await body(); } finally { AbortController.prototype.abort = original; }
}
const respondWith = async (h: EvalHarness, response: Response) => {
  askNow(h); const p = h.take(ASK); p.resolve(answered(p)); await settle();
  assert.equal(ui(h).send, 'AVAILABLE');
  h.evaluation.sendEvidence(); h.take(HANDOFF).resolve(response); await settle();
};
const handoffError = (code: string, status: number) => json({ contractVersion: 'RevalBrowserHandoffErrorV1', code }, status);

test('current 403 on the evaluation Ask: pair ended, one picker refresh, pairing blocked until a deliberate client reselection', async () => {
  const h = evalHarness(); await readyConsole(h); await paired(h);
  askNow(h); h.take(ASK).resolve(new Response('', { status: 403 })); await settle();
  assert.deepEqual([ui(h).pair, h.holder.paired(), ui(h).block, ui(h).failure?.code], [null, false, 'SCOPE_REFUSED', 'FORBIDDEN']);
  assert.ok(h.has('/clients'), 'exactly one picker refresh');
  h.take('/clients').resolve(json([{ id: 'c-db', name: 'DB (synthetic)' }, { id: 'c-two', name: 'Two (synthetic)' }])); await settle();
  h.evaluation.pair(newToken());
  assert.equal(h.has(HANDOFF), false, 'no PAIR while blocked');
  h.controller.select('c-db'); await settle();
  assert.equal(ui(h).block, null, 'a deliberate reselection lifts the block');
});

test('current 409 ASK_REMOTE_POLICY_CHANGED: pair ended, no further Ask with the stale tuple, blocked until a fresh capability (reconnect)', async () => {
  const h = evalHarness(); await readyConsole(h); await paired(h);
  askNow(h); h.take(ASK).resolve(askError('ASK_REMOTE_POLICY_CHANGED', 409)); await settle();
  assert.deepEqual([ui(h).pair, ui(h).block, ui(h).failure?.ask?.code], [null, 'POLICY_CHANGED', 'ASK_REMOTE_POLICY_CHANGED']);
  assert.equal(askNow(h), false); assert.equal(h.sent.filter(p => p.path === ASK).length, 1, 'never a second Ask with the stale acknowledgement');
  h.evaluation.pair(newToken()); assert.equal(h.has(HANDOFF), false);
  h.controller.connect(TOKEN_A); await settle();
  assert.equal(ui(h).block, null, 'a new credential epoch (fresh capability discovery) lifts it');
});

test('current 401: PAIR, evaluation Ask and RESPONSE each disconnect; a 403 SCOPE_MISMATCH on PAIR/RESPONSE blocks like a 403', async () => {
  { const h = evalHarness(); await readyConsole(h);
    h.evaluation.pair(newToken()); h.take(HANDOFF).resolve(handoffError('UNAUTHORIZED', 401)); await settle();
    assert.equal(h.unauthorized(), 1, 'PAIR 401 disconnects'); }
  { const h = evalHarness(); await readyConsole(h); await paired(h);
    askNow(h); h.take(ASK).resolve(new Response('', { status: 401 })); await settle();
    assert.equal(h.unauthorized(), 1, 'evaluation Ask 401 disconnects'); }
  { const h = evalHarness(); await readyConsole(h); await paired(h);
    await respondWith(h, handoffError('UNAUTHORIZED', 401));
    assert.deepEqual([h.unauthorized(), ui(h).send, ui(h).sendFailure?.handoff], [1, 'FAILED', 'UNAUTHORIZED'], 'RESPONSE 401 disconnects, refusal visible'); }
  { const h = evalHarness(); await readyConsole(h);
    h.evaluation.pair(newToken()); h.take(HANDOFF).resolve(handoffError('SCOPE_MISMATCH', 403)); await settle();
    assert.equal(ui(h).block, 'SCOPE_REFUSED'); }
});

test('RESPONSE refusals that revoke the pair on the server end it here; a non-revoking refusal keeps it; codes stay visible', async () => {
  for (const [code, status, ends, block] of [['PAIR_REVOKED', 503, true, null], ['FIXTURE_MISMATCH', 503, true, null], ['POLICY_CHANGED', 503, true, 'POLICY_CHANGED'],
    ['ADMISSION_NOT_ACTIVE', 503, true, 'POLICY_CHANGED'], ['CONTENT_MISMATCH', 503, false, null], ['DEADLINE', 504, false, null]] as const) {
    const h = evalHarness(); await readyConsole(h); await paired(h);
    await respondWith(h, handoffError(code, status));
    assert.deepEqual([ui(h).pair === null, ui(h).block, ui(h).send, ui(h).sendFailure?.handoff], [ends, block, 'FAILED', code], code);
  }
});

test('local refusal keeps an eligible completion and its one send; the 503 NOT_ADMITTED refusal stays visible after the pair ends', async () => {
  const h = evalHarness(); await readyConsole(h); await paired(h);
  askNow(h); const p = h.take(ASK); p.resolve(answered(p)); await settle();
  assert.equal(h.evaluation.submit('', false, false), false, 'a refused click (empty draft)');
  assert.deepEqual([ui(h).status, ui(h).send, ui(h).refusal], ['READY', 'AVAILABLE', 'EMPTY'], 'the evidence can still be sent');
  h.evaluation.sendEvidence(); assert.ok(h.has(HANDOFF));
  const k = evalHarness(); await readyConsole(k); await paired(k);
  askNow(k); k.take(ASK).resolve(askError('ASK_REMOTE_NOT_ADMITTED', 503)); await settle();
  assert.deepEqual([ui(k).pair, ui(k).status, ui(k).failure?.ask?.code], [null, 'ERROR', 'ASK_REMOTE_NOT_ADMITTED']);
});

test('an invalid 200 carrying a receipt is never handoff-eligible; the pair expiry timer ends the pair at expiresAt', async () => {
  const h = evalHarness(); await readyConsole(h); await paired(h);
  askNow(h); const p = h.take(ASK);
  const bad = answered(p); const body = JSON.parse(await bad.clone().text()); body.requestId = randomUUID();
  p.resolve(json(body, 200, { 'x-atlas-correlation-id': body.correlationId, 'x-atlas-evaluation-receipt': newToken() })); await settle();
  assert.deepEqual([ui(h).status, ui(h).failure?.code, ui(h).send], ['ERROR', 'RESPONSE_INVALID', 'NONE']);
  const k = evalHarness(); await readyConsole(k);
  k.evaluation.pair(newToken()); k.take(HANDOFF).resolve(json(pair200(focusOf('NONE'), { expiresAt: new Date(Date.now() + 60).toISOString() }))); await settle();
  assert.equal(ui(k).pairStatus, 'PAIRED');
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual([ui(k).pair, k.holder.paired()], [null, false], 'expired pair dropped by its timer');
});

test('already-resolved stale values change nothing: a late PAIR200, a late Ask 401 and a late RESPONSE 204 after an invalidation', async () => {
  await withoutAbort(async () => {
    { const h = evalHarness(); await readyConsole(h);
      h.evaluation.pair(newToken()); const p = h.take(HANDOFF);
      h.controller.connect(TOKEN_A); // credential change before the PAIR200 arrives
      p.resolve(json(pair200(focusOf('NONE')))); await settle();
      assert.deepEqual([ui(h).pairStatus === 'PAIRED', h.holder.paired()], [false, false], 'a late PAIR200 never pairs a newer credential'); }
    { const h = evalHarness(); await readyConsole(h); await paired(h);
      askNow(h); const p = h.take(ASK); h.evaluation.questionEdited();
      p.resolve(new Response('', { status: 401 })); await settle();
      assert.equal(h.unauthorized(), 0, 'a stale 401 never disconnects'); }
    { const h = evalHarness(); await readyConsole(h); await paired(h);
      askNow(h); const p = h.take(ASK); p.resolve(answered(p)); await settle();
      h.evaluation.sendEvidence(); const r = h.take(HANDOFF); h.evaluation.questionEdited();
      r.resolve(new Response(null, { status: 204 })); await settle();
      assert.equal(ui(h).send, 'NONE', 'a late 204 after an edit never shows SENT'); }
  });
});
