import { test, expect } from '@playwright/test';
import { envelope, response } from '../support/ask-remote-api.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { CORPUS, Pacer, armReady, collectFinal, installPair, openMeasured, pairBrowser, prepareQuestion, sendAndReceive } from '../support/eval-browser.ts';
import { install, pidOf, WS } from '../support/reval-fixture-pg.ts';
import { evalSandbox, startEvalServer } from '../support/reval-eval-server.ts';
import type { EvalServer, Sandbox } from '../support/reval-eval-server.ts';
import { NOTHING_RETAINED, recordConsole, tokenRetained } from '../support/operator-ui.ts';

// RS-C-C (03 "all 200 case paths"; 05 rows RS-C, Browser focus): EVERY frozen case through the sealed measured console on the
// in-process bridge S (built production composition, registered RS-B sandbox, REAL disposable PostgreSQL 17, the accepted OFFLINE
// scripted provider seam — no key, no network). Per fixture: the accepted maintenance switch installs it (policy PAUSED → install →
// ACTIVE), a fresh S starts, the operator connects, picks the client and pairs manually. Per case: C arms it and I sends READY;
// the operator types the exact frozen question, selects the ONE fixed choice, checks consent, clicks Ask and then "Send evaluation
// evidence"; the REAL instrument transfer code reruns the RC5 validators against the frozen case (request equals the frozen
// question/observationId, semantic MATCH, truth true) and COMMITs; C collects the FINAL record. All 15 FX10 cases must request the
// frozen absent ID and read it as MISSING (no focus fact, no extra focus row). The accepted per-actor limit (10 questions per 60 s)
// paces the run (≥ 20 minutes), so this evidence test runs only with ATLAS_REVAL_E2E_200=1 (like the native-cluster tests).
const ORDER = ['FX02', 'FX01', 'FX03', 'FX04', 'FX05', 'FX06', 'FX07', 'FX08', 'FX09', 'FX10', 'FX11'];
test.setTimeout(50 * 60_000);
test.skip(process.env.ATLAS_REVAL_E2E_200 !== '1', 'set ATLAS_REVAL_E2E_200=1 (paced: ≥ 20 minutes)');

test('all 200 frozen case paths (incl. 15 FX10 MISSING) through the measured pane: exact request, semantic MATCH, truth, COMMITTED handoff', async ({ page, context }) => {
  const messages = recordConsole(page);
  const sb: Sandbox = await evalSandbox({ singleActor: true }); // FX02 installed (generation 1), policy ACTIVE; one Actor row (switchable)
  let srv: EvalServer | null = null;
  const pacer = new Pacer(); const started = Date.now();
  const done: string[] = []; let fx10 = 0; let generation = '1';
  try {
    const owner = sb.ns.db.owner; const pid = await pidOf(owner);
    for (const fixtureId of ORDER) {
      if (fixtureId !== 'FX02') {
        await srv?.close(); srv = null;
        await revise(owner, WS, { state: 'PAUSED' });
        generation = (await install(owner, sb.r, fixtureId, generation, [pid])).generation;
        sb.policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
      }
      srv = await startEvalServer(sb);
      await openMeasured(page, srv, sb.tokens.actor);
      const p = await installPair(srv, sb);
      await pairBrowser(page, p.nonce);
      const focusState = fixtureId === 'FX10' ? 'MISSING' : CORPUS.fixtures.get(fixtureId)!.spec.requestedFocus === null ? 'NONE' : 'FOUND';
      await expect(page.locator('#eval-facts'), fixtureId).toContainText(focusState); // the PAIR200 focus state the pane shows
      expect(await tokenRetained(page, context, p.nonce)).toEqual(NOTHING_RETAINED);
      for (const caseId of CORPUS.order.filter(id => CORPUS.cases.get(id)!.fixtureId === fixtureId)) {
        const frozen = CORPUS.cases.get(caseId)!;
        await prepareQuestion(page, frozen.question);
        await pacer.beforeAsk(); // pace BEFORE the GO/arm: the arm's 26 s window must not be spent waiting
        const ready = await armReady(srv, sb, p, caseId, generation);
        srv.scripted.next = () => response(envelope(frozen.expectedIntent));
        await page.locator('#eval-submit').click();
        await expect(page.locator('#eval-send')).toBeEnabled();
        const r = await sendAndReceive(page, p.ho, ready, caseId, sb);
        expect(r.state, caseId).toBe('COMMITTED');
        const result = r.summary!.result!;
        expect([result.requestMatchesFrozen, result.semantic, result.publicOutcome, result.claims, result.coverage, result.urgency], caseId)
          .toEqual([true, 'MATCH', 'ANSWER', true, true, true]);
        const request = r.values!.request as { question: string; observationId: string | null };
        expect([request.question, request.observationId], caseId).toEqual([frozen.question, CORPUS.fixtures.get(fixtureId)!.spec.requestedFocus]);
        if (fixtureId === 'FX10') {
          const body = r.values!.response.body as { focusObservationId: string; coverage: { focusExtra: boolean }; evidence: { kind: string; data: { observationId?: string } }[] };
          expect(request.observationId).toBe('syn-obs-not-found');
          expect([body.focusObservationId, body.coverage.focusExtra, body.evidence.some(f => f.data.observationId === 'syn-obs-not-found')], caseId)
            .toEqual(['syn-obs-not-found', false, false]);
          fx10 += 1;
        }
        // rc2 F4: what left Atlas for this case (the offline provider capture): exactly {question, hasFocus}; hasFocus true only for a
        // FOUND focus — every FX10 case sends hasFocus:false (the frozen absent ID reads MISSING).
        const sent = JSON.parse(JSON.parse(srv.scripted.captures.at(-1)!.bytes).messages[1].content) as { question: string; hasFocus: boolean };
        expect([Object.keys(sent).sort(), sent.question, sent.hasFocus], caseId).toEqual([['hasFocus', 'question'], frozen.question, focusState === 'FOUND']);
        if (fixtureId === 'FX10') expect(sent.hasFocus).toBe(false);
        const obs = await collectFinal(srv, ready.armId);
        expect([obs.detectedFault, obs.publication.state, obs.publication.kind], caseId).toEqual(['NONE', 'SERVER_FINISHED', 'ANSWER']);
        done.push(caseId);
      }
    }
    expect(done.length).toBe(200);
    expect(new Set(done).size).toBe(200);
    expect(fx10).toBe(15);
    expect(messages).toEqual([]);
    console.log(`# REVAL_EVIDENCE RS-C-C 200 case paths through the measured pane: ${done.length} COMMITTED (semantic MATCH, truth true), FX10 MISSING ${fx10}, ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await srv?.close();
    await sb.ns.cleanup();
  }
});
