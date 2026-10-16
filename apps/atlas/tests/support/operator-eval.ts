import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createController } from '../../apps/operator/src/controller.ts';
import type { ConsoleState } from '../../apps/operator/src/state.ts';
import { createMeasuredHolder } from '../../apps/operator/measured/credential-measured.ts';
import { createEvalController } from '../../apps/operator/measured/eval-controller.ts';
import type { EvaluationFocus } from '../../apps/operator/measured/eval-contracts.ts';
import { dbContext } from './operator-fixtures.ts';
import { journeyItems, page, WS } from './operator-journey.ts';
import { journeyRemoteAnswer, remoteCapabilityResponse } from './operator-ask-remote.ts';

/**
 * TEST-ONLY harness of the measured evaluation pane (rs-c brief C §3, §4): the ACCEPTED console controller on the measured
 * holder with a fake fetch whose requests stay pending until the test resolves them (it ignores AbortSignal, like a stalled
 * network), plus the evaluation controller observing every console state. Synthetic values only; no network.
 */
export const TOKEN_A = 'synthetic-console-token-aaaaaaaaaaaa';
export const CL = 'c-db';
export const CLIENTS = [{ id: CL, name: 'DB (synthetic)' }, { id: 'c-two', name: 'Two (synthetic)' }];
export const ASK = `/clients/${CL}/ask`;
export const HANDOFF = `/clients/${CL}/ask/evaluation-handoff`;
export const newToken = (): string => randomBytes(32).toString('base64url');
export interface Pending { method: string; path: string; body: string | null; headers: Headers; resolve(response: Response): void }
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
export const settle = () => new Promise(resolve => setTimeout(resolve, 10));
export const focusOf = (state: EvaluationFocus['focusState'], requestedFocus: string | null = null): EvaluationFocus => ({ registrationId: randomUUID(), fixtureId: 'FX02',
  fixtureGeneration: '1', requestedFocus, focusState: state, syntheticFreshnessAt: '2026-10-10T08:00:00.000Z' });
export const pair200 = (focus: EvaluationFocus, over: Record<string, unknown> = {}) => ({ contractVersion: 'RevalBrowserHandoffV1', pairId: randomUUID(),
  sessionToken: newToken(), serverBootId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString(), evaluationFocus: focus, ...over });

export function evalHarness() {
  const pending: Pending[] = []; const sent: Pending[] = [];
  const holder = createMeasuredHolder((path, init) => new Promise<Response>(resolve => {
    const p = { method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : null, headers: new Headers(init.headers), resolve };
    pending.push(p); sent.push(p);
  }));
  const renders: number[] = [];
  let evaluation: ReturnType<typeof createEvalController> | null = null;
  const controller = createController(holder, (state: ConsoleState) => evaluation?.observe(state), { deadlineMs: 2000 });
  let unauthorized = 0;
  evaluation = createEvalController(holder, ui => renders.push(ui.formGeneration), { onUnauthorized: () => { unauthorized += 1; },
    onForbidden: () => controller.refreshClients() }); // as main-measured.ts
  evaluation.observe(controller.state());
  const take = (prefix: string): Pending => {
    const index = pending.findLastIndex(p => p.path.split('?')[0] === prefix);
    assert.ok(index >= 0, `request ${prefix}`);
    return pending.splice(index, 1)[0]!;
  };
  const has = (prefix: string) => pending.some(p => p.path.split('?')[0] === prefix);
  return { holder, controller, evaluation, pending, sent, take, has, renders, unauthorized: () => unauthorized };
}
export type EvalHarness = ReturnType<typeof evalHarness>;

/** Connected, client selected, DB context and queue validated, REMOTE capability (the accepted console journey). */
export async function readyConsole(h: EvalHarness, client = CL): Promise<void> {
  h.controller.connect(TOKEN_A);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  h.take('/ask/capabilities').resolve(remoteCapabilityResponse()); await settle();
  h.controller.select(client);
  h.take(`/clients/${client}/overview`).resolve(json(dbContext(client, WS))); await settle();
  h.take(`/clients/${client}/observations`).resolve(json(page(journeyItems().map(o => ({ ...o, clientId: client }))))); await settle();
}
/** Manual pairing with a typed nonce and the given PAIR200 (must succeed). */
export async function paired(h: EvalHarness, focus: EvaluationFocus = focusOf('NONE')): Promise<ReturnType<typeof pair200>> {
  const body = pair200(focus);
  h.evaluation.pair(newToken());
  h.take(HANDOFF).resolve(json(body)); await settle();
  assert.equal(h.evaluation.state().pairStatus, 'PAIRED');
  return body;
}
/** The R-B answer for the recorded evaluation Ask body, with the server's receipt header. */
export function answered(p: Pending, receipt: string | null = newToken(), intent: 'SUMMARY' | 'UNSUPPORTED' = 'SUMMARY'): Response {
  const body = JSON.parse(p.body!);
  const answer = journeyRemoteAnswer(body, intent, CL);
  return json(answer, 200, { 'x-atlas-correlation-id': answer.correlationId, ...(receipt === null ? {} : { 'x-atlas-evaluation-receipt': receipt }) });
}
/** Type → choose → consent → Ask, as the operator does; returns whether a request was sent. */
export function askNow(h: EvalHarness, question = 'What needs attention for this client right now?'): boolean {
  h.evaluation.questionEdited();
  h.evaluation.choose();
  h.evaluation.consentChanged(true, question);
  return h.evaluation.submit(question, true, true);
}
