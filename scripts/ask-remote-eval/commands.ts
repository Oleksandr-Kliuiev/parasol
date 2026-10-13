import { writeFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http2 from 'node:http2';
import { ADJUDICATION_DIR, readAdjudication, REFUSAL_TEMPLATE, refusalTemplate, SUPPORTED_TEMPLATE, supportedTemplate, validateRefusalReview, validateSupportedReview } from './adjudication.ts';
import { CORPUS_FILES, dataPath, flattenCorpus, loadCorpusFiles, MANIFEST_FILE, readData, stableOrder, validateCorpus } from './dataset.ts';
import type { EvalCase } from './dataset.ts';
import { assertSafeReceipt, datasetManifest, UNVERIFIED } from './evidence.ts';
import { expectationIssues, loadFixtureFile } from './fixtures.ts';
import { fixtureMatrix, prepareFixtures, runCase } from './harness.ts';
import { blockedAttempts, BLOCKED_CODE, networkGuardInstalled } from './net-guard.ts';
import { PREDICATE_VERSION } from './predicates.ts';
import { scenarios } from './scenarios.ts';

// Offline CLI commands (loaded by cli.ts only AFTER the network guard is installed). Outputs are safe JSON receipts.

const load = () => {
  const file = loadFixtureFile();
  const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
  const fixtures = prepareFixtures(file);
  return { file, cases, fixtures };
};

export function verify(): Record<string, unknown> {
  const { file, cases, fixtures } = load();
  const corpusIssues = validateCorpus(cases, new Set(fixtures.keys()), new Map(file.fixtures.map(f => [f.fixtureId, f.hasFocus])));
  const fixtureIssues = [...fixtures.values()].flatMap(f => [...f.reachability, ...expectationIssues(f.spec)].map(i => `${f.spec.fixtureId}:${i}`));
  const committed = JSON.parse(readData(MANIFEST_FILE).toString('utf8')) as unknown;
  const manifestMatches = JSON.stringify(committed) === JSON.stringify(datasetManifest(cases));
  const refusal = validateRefusalReview(readAdjudication(REFUSAL_TEMPLATE), cases);
  const supported = validateSupportedReview(readAdjudication(SUPPORTED_TEMPLATE), cases);
  const lineLimits = CORPUS_FILES.every(name => readData(name).toString('utf8').split('\n').length <= 501);
  const ok = corpusIssues.length === 0 && fixtureIssues.length === 0 && manifestMatches && refusal.issues.length === 0 && supported.issues.length === 0 && lineLimits;
  return { command: 'verify', ok, corpusIssues: corpusIssues.map(i => i.caseId ? `${i.code}:${i.caseId}` : i.code), fixtureIssues, manifestMatches, lineLimits,
    humanReview: { refusalResolved: refusal.resolved, refusalTotal: refusal.total, supportedResolved: supported.resolved, supportedTotal: supported.total,
      humanAttestationComplete: refusal.humanAttestationComplete && supported.humanAttestationComplete, issues: [...refusal.issues, ...supported.issues].slice(0, 20) } };
}

export function harness(): Record<string, unknown> {
  const { file, cases, fixtures } = load();
  const runs = cases.map(c => runCase(c, fixtures, file.scope));
  const matrix = fixtureMatrix(fixtures, file.scope);
  const wirePass = runs.every(r => r.wire.requestOk && r.wire.payloadOk && r.wire.hasFocusOk && r.wire.noSourceOnWire);
  const ok = wirePass && runs.every(r => r.verdict === 'CASE_PASS') && matrix.every(m => m.pass) && matrix.length === fixtures.size * 5;
  return { command: 'harness', ok, semanticEvaluation: false, liveQualityScore: null, predicateVersion: PREDICATE_VERSION,
    note: 'Scripted provider returns the DRAFT label: this rehearses the pipeline and local predicates; it does not measure classification.',
    casesRun: runs.length, wirePass, localProjectionPass: runs.filter(r => r.truthPass === true).length,
    fixtureMatrix: { fixtures: fixtures.size, checks: matrix.length, pass: matrix.filter(m => m.pass).length },
    cases: runs.map(r => ({ caseId: r.caseId, wire: r.wire.requestOk && r.wire.payloadOk && r.wire.hasFocusOk && r.wire.noSourceOnWire ? 'PASS' : 'FAIL',
      semantic: r.semantic, local: r.truthPass ? 'PASS' : 'FAIL', verdict: r.verdict })) };
}

export function rehearse(): Record<string, unknown> {
  const { file, cases, fixtures } = load();
  const manifest = datasetManifest(cases) as { corpusSha256: string; fixtures: { sha256: string } };
  const { order, orderSha256 } = stableOrder(cases.map(c => c.caseId));
  const results = scenarios({ cases, fixtures, scope: file.scope, order, datasetSha256: manifest.corpusSha256, fixtureSha256: manifest.fixtures.sha256, orderSha256 });
  return { command: 'rehearse', ok: results.every(r => r.pass), simulated: true, productionAuthorityProof: false,
    scenarios: results.map(r => ({ scenarioId: r.scenarioId, pass: r.pass, expected: r.expected, observed: r.observed })) };
}

/** Every guarded surface must throw OFFLINE_EGRESS_BLOCKED synchronously or reject; targets are loopback/.invalid only. */
export async function guardSelftest(): Promise<Record<string, unknown>> {
  const probes: [string, () => unknown][] = [
    ['fetch', () => fetch('http://127.0.0.1:9/')], ['http.request', () => http.request('http://127.0.0.1:9/')], ['http.get', () => http.get('http://127.0.0.1:9/')],
    ['https.request', () => https.request('https://offline-guard.invalid/')], ['https.get', () => https.get('https://offline-guard.invalid/')],
    ['http2.connect', () => http2.connect('https://offline-guard.invalid')], ['net.connect', () => net.connect(9, '127.0.0.1')],
    ['net.createConnection', () => net.createConnection(9, '127.0.0.1')], ['net.Socket.connect', () => new net.Socket().connect(9, '127.0.0.1')],
    ['tls.connect', () => tls.connect(9, '127.0.0.1')], ['dgram.createSocket', () => dgram.createSocket('udp4')],
    ['dns.lookup', () => dns.lookup('offline-guard.invalid', () => undefined)], ['dns.resolve4', () => dns.resolve4('offline-guard.invalid', () => undefined)],
    ['dns.promises.lookup', () => dns.promises.lookup('offline-guard.invalid')], ['dns.promises.resolve', () => dns.promises.resolve('offline-guard.invalid')],
    ['WebSocket', () => new (globalThis as unknown as { WebSocket: new (u: string) => unknown }).WebSocket('ws://127.0.0.1:9/')]
  ];
  const results: { surface: string; blocked: boolean }[] = [];
  for (const [surface, probe] of probes) {
    let blocked = false;
    try { const value = probe(); if (value instanceof Promise) await value; } catch (e) { blocked = (e as { code?: string }).code === BLOCKED_CODE || (e as Error).message === BLOCKED_CODE; }
    results.push({ surface, blocked });
  }
  return { command: 'guard-selftest', ok: networkGuardInstalled() && results.every(r => r.blocked), guardInstalled: networkGuardInstalled(), results };
}

export function writeManifest(): Record<string, unknown> {
  const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
  writeFileSync(dataPath(MANIFEST_FILE), `${JSON.stringify(datasetManifest(cases), null, 2)}\n`);
  return { command: 'write-manifest', ok: true };
}
export function writeReviewTemplates(): Record<string, unknown> {
  const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
  writeFileSync(new URL(REFUSAL_TEMPLATE, ADJUDICATION_DIR), refusalTemplate(cases));
  writeFileSync(new URL(SUPPORTED_TEMPLATE, ADJUDICATION_DIR), supportedTemplate(cases));
  return { command: 'write-review-templates', ok: true };
}

export async function all(writeReceipt: boolean): Promise<Record<string, unknown>> {
  const v = verify(); const h = harness(); const r = rehearse();
  const blockedDuringPipeline = blockedAttempts().length;
  const g = await guardSelftest();
  const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
  const manifest = datasetManifest(cases) as Record<string, unknown>;
  const receipt = { artifact: 'S5ASKREMOTE-REVAL-OFFLINE-RECEIPT', version: 'reval-offline-receipt-v1', ok: v.ok === true && h.ok === true && r.ok === true && g.ok === true && blockedDuringPipeline === 0,
    mode: 'OFFLINE_ONLY', paidProviderCalls: 0, networkEgress: 'GUARDED_FAIL_CLOSED', blockedDuringPipeline, semanticEvaluation: false, liveQualityScore: null,
    labelStatus: 'DRAFT_MODEL_ASSISTED', humanAttestation: 'PENDING', dataAdmission: 'NOT_ADMITTED', budgetAdmission: 'NOT_ADMITTED',
    dataset: { corpusSha256: manifest.corpusSha256, fixturesSha256: (manifest.fixtures as { sha256: string }).sha256, orderSha256: manifest.orderSha256, caseCount: manifest.caseCount },
    verify: v, harness: h, rehearsal: r, guardSelftest: g, unverified: UNVERIFIED };
  assertSafeReceipt(receipt, cases);
  if (writeReceipt) writeFileSync(new URL('../../docs/stage5/ask/remote/eval/rehearsal/OFFLINE_REHEARSAL_RECEIPT.json', import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
