import { test, expect } from '@playwright/test';
import { envelope, response } from '../support/ask-remote-api.ts';
import { CORPUS, armReady, collectFinal, installPair, openMeasured, pairBrowser, prepareQuestion, sendAndReceive } from '../support/eval-browser.ts';
import { evalSandbox, startEvalServer } from '../support/reval-eval-server.ts';
import type { EvalServer, Sandbox } from '../support/reval-eval-server.ts';
import { newToken } from '../../packages/reval/eval-wire.ts';
import { NOTHING_RETAINED, recordConsole, recordRequests, tokenRetained } from '../support/operator-ui.ts';

// RS-C-C measured pane in a REAL browser (05 rows Browser focus / Browser generations; 04 transition table) on the in-process bridge
// S over the registered RS-B sandbox (FX02, FOUND focus syn-obs-b2), CSP enforced, offline scripted provider only. Pairing is a
// manual plain field (no probe); the ordinary Ask form is never offered; typing/selection/edit/consent follow the 04 table; submit
// clears the form without losing its answer; an edit retires the handoff; pagehide/bfcache drop everything; nothing secret is kept.
let sb: Sandbox; let srv: EvalServer;
test.beforeAll(async () => { sb = await evalSandbox(); srv = await startEvalServer(sb); });
test.afterAll(async () => { await srv?.close(); await sb?.ns.cleanup(); });
const FX02 = CORPUS.order.filter(id => CORPUS.cases.get(id)!.fixtureId === 'FX02');

test('manual pairing, one fixed choice and the exact 04 transitions in a real browser; ordinary Ask never offered; nothing retained', async ({ page, context }) => {
  const messages = recordConsole(page);
  const seen = recordRequests(page, `http://127.0.0.1:${srv.port}`);
  await openMeasured(page, srv, sb.tokens.actor);
  await expect(page.locator('#ask-panel')).toBeHidden();
  await expect(page.locator('#eval-pane')).toBeHidden();
  expect(seen.filter(r => r.path.endsWith('/ask/evaluation-handoff')).length, 'no automatic PAIR probe').toBe(0);
  // A well-formed but unknown code: a fixed failure, no pane.
  await page.locator('#eval-nonce').fill(newToken());
  await page.locator('#eval-pair').click();
  await expect(page.locator('#eval-pair-status')).toContainText('Pairing failed');
  await expect(page.locator('#eval-pane')).toBeHidden();
  await expect(page.locator('#eval-nonce')).toHaveValue('');
  const p = await installPair(srv, sb);
  await pairBrowser(page, p.nonce);
  const q = page.locator('#eval-question'); const choice = page.locator('#eval-choice'); const consent = page.locator('#eval-consent');
  await expect(q).toHaveValue(''); await expect(choice).not.toBeChecked(); await expect(consent).not.toBeChecked();
  await expect(page.locator('#eval-choice-label')).toContainText('syn-obs-b2');
  // Typing keeps the newest draft; consent without the choice stays unchecked; selection keeps the draft.
  await q.pressSequentially('What needs');
  await q.pressSequentially(' attention?');
  await consent.click();
  await expect(consent).not.toBeChecked();
  await choice.check();
  await expect(q).toHaveValue('What needs attention?');
  await consent.check(); await expect(consent).toBeChecked();
  // An edit after selection clears the choice and the consent, keeps the edited draft.
  await q.pressSequentially(' Now');
  await expect(choice).not.toBeChecked(); await expect(consent).not.toBeChecked();
  await expect(q).toHaveValue('What needs attention? Now');
  // A real case: re-select, consent, Ask after GO; the form is cleared at submit and the answer still arrives.
  const caseId = FX02[0]!; const frozen = CORPUS.cases.get(caseId)!;
  await prepareQuestion(page, frozen.question);
  const ready = await armReady(srv, sb, p, caseId, '1');
  srv.scripted.next = () => response(envelope(frozen.expectedIntent));
  await page.locator('#eval-submit').click();
  await expect(q).toHaveValue(''); await expect(choice).not.toBeChecked(); await expect(consent).not.toBeChecked();
  await expect(page.locator('#eval-send')).toBeEnabled();
  await expect(page.locator('#eval-answer')).not.toBeEmpty();
  // An edit now retires the eligible handoff (it can never be sent for another draft).
  await q.pressSequentially('x');
  await expect(page.locator('#eval-send-row')).toBeHidden();
  await expect(page.locator('#eval-answer')).toBeEmpty();
  // The un-sent case keeps S's raw slot live (≤ 120 s), which blocks the next arm: C ends the pair (the slot burns), collects the
  // FINAL record, and the operator pairs again with a fresh code (never restoration).
  expect(srv.runtime.endPair(p.pairId)).not.toBe('PAIR_UNAVAILABLE');
  await collectFinal(srv, ready.armId);
  const p2 = await installPair(srv, sb);
  await pairBrowser(page, p2.nonce);
  await expect(q).toHaveValue('');
  // Next case end to end.
  const next = FX02[1]!; const nf = CORPUS.cases.get(next)!;
  await prepareQuestion(page, nf.question);
  const r2 = await armReady(srv, sb, p2, next, '1');
  srv.scripted.next = () => response(envelope(nf.expectedIntent));
  await page.locator('#eval-submit').click();
  await expect(page.locator('#eval-send')).toBeEnabled();
  const t = await sendAndReceive(page, p2.ho, r2, next, sb);
  expect([t.state, t.summary?.result?.requestMatchesFrozen]).toEqual(['COMMITTED', true]);
  await expect(page.locator('#eval-send')).toBeDisabled();
  await collectFinal(srv, r2.armId);
  // rc2 F4 layout: at the accepted console widths the measured panel has no horizontal overflow and its controls stay visible.
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal overflow at ${width}px`).toBe(true);
    for (const id of ['#eval-question', '#eval-choice', '#eval-consent', '#eval-submit', '#eval-pair']) await expect(page.locator(id), `${id} at ${width}px`).toBeVisible();
  }
  // Nothing secret anywhere in the page, URL, storage or cookies.
  for (const secret of [sb.tokens.actor, p.nonce, p2.nonce, nf.question]) expect(await tokenRetained(page, context, secret)).toEqual(NOTHING_RETAINED);
  // pagehide → bfcache restore: disconnected, the pane gone, a fresh pairing would be needed.
  await page.goto('about:blank'); await page.goBack();
  await expect(page.locator('#eval-pane')).toBeHidden();
  await expect(page.locator('#eval-panel')).toBeHidden();
  // Chromium's own resource line for the ONE deliberate failed pairing (unknown code → 503 PAIR_UNAVAILABLE); nothing else.
  expect(messages).toEqual(['error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
});
