import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { newToken } from '../../packages/reval/eval-wire.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import { receiveTransfer } from '../../scripts/reval-instrument/transfer.ts';
import type { ReadySent, TransferResult } from '../../scripts/reval-instrument/transfer.ts';
import { HandoffClient } from './reval-eval-server.ts';
import type { EvalServer, Sandbox } from './reval-eval-server.ts';
import { submitToken } from './operator-ui.ts';

/**
 * TEST-ONLY browser roles for the RS-C-C measured pane (rs-c brief C §4). The test plays C (pair install, ARM_CASE, terminal
 * collection) on the in-process bridge S hub and I (READY on a measured handoff connection; the TRANSFER is received by the REAL
 * RS-C-B instrument code `receiveTransfer`, which reruns the accepted RC5 validators against the FROZEN case), while the browser
 * performs every manual step on the sealed measured console: pairing code, typed question, the one fixed choice, consent, Ask,
 * "Send evaluation evidence". Synthetic data only; loopback only.
 */
export const CORPUS = bindCorpus(verifyRevision().snapshot).corpus;
export const ctxOf = (caseId: string) => {
  const frozen = CORPUS.cases.get(caseId)!;
  return { frozen, fixture: CORPUS.fixtures.get(frozen.fixtureId)!, scope: CORPUS.scope };
};

/** C installs a pair for the browser (both instrument connections live) and returns the nonce the owner would show. */
export async function installPair(srv: EvalServer, sb: Sandbox): Promise<{ pairId: string; nonce: string; ho: HandoffClient }> {
  const ctl = randomUUID(); const ho = await HandoffClient.open(srv.handoffPath, ctl); srv.clients.push(ho);
  const nonce = newToken(); const pairId = randomUUID();
  const installed = srv.runtime.installPair({ contractVersion: 'RevalPairSecretV1', registrationId: sb.r.registrationId, serverBootId: srv.serverBootId,
    connectionId: randomUUID(), sequence: '3', challenge: randomUUID(), requestSequence: '3', pairId, instrumentControlConnectionId: ctl,
    instrumentHandoffConnectionId: ho.connectionId, pairingNonce: nonce, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  if (typeof installed === 'string') throw new Error(`install ${installed}`);
  return { pairId, nonce, ho };
}

/** The operator connects, picks the registered client and waits for the validated DB context and the measured panel. */
export async function openMeasured(page: Page, srv: EvalServer, bearer: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${srv.port}/operator/`);
  await submitToken(page, bearer);
  await page.getByRole('button', { name: /Synthetic client/ }).click();
  await expect(page.locator('#eval-panel')).toBeVisible();
}
/** Manual pairing: the code is typed into the plain password field; PAIR200 shows the pane. */
export async function pairBrowser(page: Page, nonce: string): Promise<void> {
  await page.locator('#eval-nonce').fill(nonce);
  await page.locator('#eval-pair').click();
  await expect(page.locator('#eval-pair-status')).toContainText('Paired until');
  await expect(page.locator('#eval-pane')).toBeVisible();
}

/** C arms one case and I sends READY on its handoff connection (both must succeed). */
export async function armReady(srv: EvalServer, sb: Sandbox, p: { pairId: string; ho: HandoffClient }, caseId: string, generation: string): Promise<ReadySent> {
  const frozen = CORPUS.cases.get(caseId)!;
  const arm = await srv.runtime.armCase({ caseId, fixtureId: frozen.fixtureId, fixtureGeneration: generation, admissionId: sb.admissionId, policyVersion: sb.policyVersion,
    preSnapshotId: randomUUID(), browserPairId: p.pairId });
  if (typeof arm === 'string') throw new Error(`arm ${caseId} ${arm}`);
  const ready = { challenge: randomUUID(), registrationId: sb.r.registrationId, serverBootId: srv.serverBootId, pairId: p.pairId, armId: arm.armId, caseId,
    fixtureId: arm.fixtureId, fixtureGeneration: arm.fixtureGeneration, admissionId: arm.admissionId, policyVersion: arm.policyVersion, preSnapshotId: arm.preSnapshotId };
  const sequence = p.ho.send({ contractVersion: 'RevalTransientReadyV1', ...ready });
  const ack = await p.ho.next();
  if (ack.disposition !== 'READY') throw new Error(`READY ${caseId} ${JSON.stringify(ack)}`);
  return { ...ready, sequence };
}

/** The operator's manual steps for one question (preparation before GO, Ask only after it). */
export async function prepareQuestion(page: Page, question: string): Promise<void> {
  await page.locator('#eval-question').fill(question);
  await page.locator('#eval-choice').check();
  await page.locator('#eval-consent').check();
}

/** I receives the one TRANSFER with the real instrument code while the operator clicks "Send evaluation evidence". */
export async function sendAndReceive(page: Page, ho: HandoffClient, ready: ReadySent, caseId: string, sb: Sandbox): Promise<TransferResult> {
  const received = receiveTransfer(ho, ready, ctxOf(caseId), { admissionId: sb.admissionId, policyVersion: sb.policyVersion }, performance.now() + 15_000, () => true);
  await page.locator('#eval-send').click();
  const r = await received;
  await expect(page.locator('#eval-send-status')).toContainText('HTTP 204');
  return r;
}

/** C collects the case's FINAL terminal record (the next arm requires it). */
export async function collectFinal(srv: EvalServer, armId: string): Promise<{ final: boolean; detectedFault: string; publication: { state: string; kind: string } }> {
  for (let i = 0; i < 400; i += 1) {
    const o = srv.runtime.terminal(armId);
    if (typeof o !== 'string' && o.final) { if (!srv.runtime.collected(armId, o.observationId, o.revision)) throw new Error('collect'); return o; }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`observation never became final for ${armId}`);
}

/**
 * The accepted per-actor Ask limit (packages/ask/contracts.ts ASK_LIMITS: 10 questions per rolling 60 s; the registration admits ONE
 * actor) paces the operator exactly as the RC5 instrument's pacing does: before each Ask, wait until fewer than 10 were sent in the
 * last 60 s (plus a margin). Nothing is retried; a BUSY answer would still fail the run.
 */
export class Pacer {
  readonly #sent: number[] = [];
  async beforeAsk(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.#sent.length > 0 && this.#sent[0]! <= now - 61_500) this.#sent.shift();
      if (this.#sent.length < 10) { this.#sent.push(now); return; }
      await new Promise(r => setTimeout(r, Math.max(50, this.#sent[0]! + 61_500 - now)));
    }
  }
}
