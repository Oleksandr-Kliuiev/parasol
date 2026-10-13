import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Corpus, ExecutionSession } from '../../scripts/ask-remote-eval-execution/session.ts';
import type { MeasuredRun } from '../../scripts/reval-instrument/run.ts';

/**
 * TEST-ONLY shared parts of the PTY instrument drivers (NB7 rehearsal, RS-D-A segment rehearsal): a raw-mode line reader, loopback
 * HTTP with full header control (this process also plays the browser), and one case played exactly as the operator and the measured
 * pane would — RC5 capability/stage/consent, the instrument's GO, the browser's question and RESPONSE handoff, handoff and finish.
 * Synthetic values only; no question, token or value is printed.
 */
export interface HttpResult { status: number; headers: Record<string, unknown>; body: string }
export function lineReader(): () => Promise<string> {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let buffered = '';
  return () => new Promise(resolve => {
    const take = () => { const i = buffered.indexOf('\r'); if (i < 0) return false; const l = buffered.slice(0, i); buffered = buffered.slice(i + 1); resolve(l); return true; };
    if (take()) return;
    const on = (d: Buffer) => { buffered += d.toString('utf8'); if (take()) process.stdin.off('data', on); };
    process.stdin.on('data', on);
  });
}
export function httpTo(port: number) {
  return (method: string, path: string, body: string | null, headers: Record<string, string>): Promise<HttpResult> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body ?? undefined);
  });
}
export interface Browser { pairId: string; sessionToken: string; policyVersion: string }
export interface CaseDriverOptions {
  readonly port: number; readonly bearer: string; readonly clientId: string; readonly admissionId: string;
  readonly session: ExecutionSession; readonly corpus: Corpus; readonly run: MeasuredRun; readonly browser: () => Browser;
}
export function caseDriver(o: CaseDriverOptions) {
  const http = httpTo(o.port);
  const headers = (extra: Record<string, string> = {}) => ({ origin: `http://127.0.0.1:${o.port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    authorization: `Bearer ${o.bearer}`, ...extra });
  const handoffPath = `/clients/${o.clientId}/ask/evaluation-handoff`;
  /** The browser PAIR with the owner's nonce; returns the session token. */
  async function pair(nonce: string): Promise<string> {
    const p = await http('POST', handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce }), headers());
    if (p.status !== 200) throw new Error(`PAIR ${p.status}`);
    return JSON.parse(p.body).sessionToken as string;
  }
  /** RC5 capability preflight, stage and consent for `caseId` (the operator's GO preconditions). */
  async function prepare(caseId: string): Promise<void> {
    const cap = await http('GET', '/ask/capabilities', null, { authorization: `Bearer ${o.bearer}` });
    if (o.session.capability({ status: String(cap.status), correlationHeader: String(cap.headers['x-atlas-correlation-id']), body: cap.body }) !== 'OK') throw new Error('CAPABILITY');
    const c = o.corpus.cases.get(caseId)!;
    if (o.session.stage(caseId, o.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus ?? 'none', c.question) !== 'STAGED') throw new Error('STAGE');
    if (o.session.consent(caseId, o.session.consentChallenge(caseId), true) !== 'CONSENTED') throw new Error('CONSENT');
  }
  /** The measured pane's question for the GO'd case and its RESPONSE handoff of exactly what it received. */
  async function browserCase(caseId: string): Promise<void> {
    const c = o.corpus.cases.get(caseId)!; const b = o.browser();
    const body = JSON.stringify({ contractVersion: 'AskRequestV2', requestId: randomUUID(), question: c.question, observationId: o.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus,
      acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: o.admissionId, policyVersion: b.policyVersion, questionDataClass: 'SYNTHETIC' } });
    const q = await http('POST', `/clients/${o.clientId}/ask`, body, headers({ 'x-atlas-evaluation-session': b.sessionToken }));
    const r = await http('POST', handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: b.pairId,
      receiptNonce: q.headers['x-atlas-evaluation-receipt'], request: JSON.parse(body),
      response: { status: q.status, correlationId: q.headers['x-atlas-correlation-id'], body: JSON.parse(q.body) } }), headers({ 'x-atlas-evaluation-session': b.sessionToken }));
    if (r.status !== 204) throw new Error(`RESPONSE ${r.status}`);
  }
  /** One whole case: prepare → GO → browser → handoff → finish; returns the finish line. */
  async function play(caseId: string): Promise<string> {
    await prepare(caseId);
    const go = await o.run.go(caseId);
    if (!go.startsWith('GO_CLICK_ASK_NOW')) throw new Error(`GO ${go}`);
    await browserCase(caseId);
    const h = await o.run.handoff(); const f = await o.run.finish();
    // The run stays ACTIVE until its last frozen case, which completes it (RC5 COMPLETE_PENDING_REVIEW).
    if (h !== 'HANDOFF_COMMITTED' || !(f.startsWith(`CASE_RECORDED ${caseId} ACTIVE COMMITTED`) || f.startsWith(`CASE_RECORDED ${caseId} COMPLETE_PENDING_REVIEW COMMITTED`))) {
      throw new Error(`FINISH ${h} ${f}`);
    }
    return f;
  }
  return { http, pair, prepare, browserCase, play };
}
