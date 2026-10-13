import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { flattenCorpus, loadCorpusFiles } from '../scripts/ask-remote-eval/dataset.ts';
import type { EvalCase } from '../scripts/ask-remote-eval/dataset.ts';
import { receiptIssues } from '../scripts/ask-remote-eval/evidence.ts';

// R-EVAL offline CLI in actual child processes: fail-closed network guard (including ESM named bindings and the production
// transport's https binding), the full offline receipt, its privacy scan and reproducibility, and the absence of any live
// mode, environment input or network path in the package.

const root = new URL('../', import.meta.url);
const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ask-remote-eval/cli.ts', ...args],
  { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 120_000 });
const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
const scriptDir = new URL('../scripts/ask-remote-eval/', import.meta.url);
const sources = readdirSync(scriptDir).filter(f => f.endsWith('.ts')).map(f => [f, readFileSync(new URL(f, scriptDir), 'utf8')] as const);

test('guard self-test: every outbound surface throws OFFLINE_EGRESS_BLOCKED before I/O (loopback/.invalid targets only)', () => {
  const r = cli('guard-selftest');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { ok: boolean; results: { surface: string; blocked: boolean }[] };
  assert.equal(out.results.length, 16);
  assert.deepEqual(out.results.filter(x => !x.blocked), []);
});

test('guard: ESM named bindings, a later-imported production transport module and this test process are all blocked', async () => {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `
    await import('./scripts/ask-remote-eval/guard-preload.ts');
    const { request } = await import('node:https');
    const https = (await import('node:https')).default;
    await import('./packages/ask/remote/transport.ts');
    const results = [];
    for (const f of [() => request('https://offline-guard.invalid/'), () => https.request('https://offline-guard.invalid/'), () => fetch('http://127.0.0.1:9/')]) {
      try { await f(); results.push('NOT_BLOCKED'); } catch (e) { results.push(e.code); }
    }
    const { blockedAttempts } = await import('./scripts/ask-remote-eval/net-guard.ts');
    process.stdout.write(JSON.stringify({ results, labels: blockedAttempts() }));`], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { results: ['OFFLINE_EGRESS_BLOCKED', 'OFFLINE_EGRESS_BLOCKED', 'OFFLINE_EGRESS_BLOCKED'], labels: ['https.request', 'https.request', 'fetch'] });
  await assert.rejects(async () => fetch('http://127.0.0.1:9/'), /OFFLINE_EGRESS_BLOCKED/);
});

test('all: complete offline receipt is ok, reproducible, privacy-clean and explicit about what remains unverified', () => {
  const r = cli('all');
  assert.equal(r.status, 0, r.stderr.slice(0, 2000));
  const receipt = JSON.parse(r.stdout) as Record<string, any>;
  assert.equal(receipt.ok, true);
  assert.deepEqual([receipt.mode, receipt.paidProviderCalls, receipt.blockedDuringPipeline, receipt.semanticEvaluation, receipt.liveQualityScore],
    ['OFFLINE_ONLY', 0, 0, false, null]);
  assert.deepEqual([receipt.labelStatus, receipt.humanAttestation, receipt.dataAdmission, receipt.budgetAdmission], ['DRAFT_MODEL_ASSISTED', 'PENDING', 'NOT_ADMITTED', 'NOT_ADMITTED']);
  assert.equal(receipt.harness.casesRun, 200);
  assert.deepEqual(receipt.harness.fixtureMatrix, { fixtures: 11, checks: 55, pass: 55 });
  assert.ok(receipt.rehearsal.scenarios.length >= 20 && receipt.rehearsal.scenarios.every((s: { pass: boolean }) => s.pass));
  assert.equal(receipt.rehearsal.productionAuthorityProof, false);
  assert.ok(receipt.unverified.includes('LIVE_PROVIDER_CLASSIFICATION_QUALITY') && receipt.unverified.includes('HUMAN_LABEL_ATTESTATION'));
  assert.deepEqual(receiptIssues(receipt, cases), []);
  for (const c of receipt.harness.cases) assert.deepEqual(Object.keys(c), ['caseId', 'wire', 'semantic', 'local', 'verdict']);
  for (const c of cases) assert.ok(!r.stdout.includes(JSON.stringify(c.question).slice(1, -1)), c.caseId);
  const committed = readFileSync(new URL('../docs/stage5/ask/remote/eval/rehearsal/OFFLINE_REHEARSAL_RECEIPT.json', import.meta.url), 'utf8');
  assert.equal(r.stdout, committed, 'the committed receipt is exactly reproducible');
});

test('privacy scan negatives: a receipt carrying question text or forbidden keys is rejected', () => {
  assert.ok(receiptIssues({ x: cases[10]!.question }, cases).some(i => i.startsWith('QUESTION_TEXT')));
  assert.ok(receiptIssues({ records: [{ caseId: 'RE-SUM-001', observedIntent: 'SUMMARY' }] }, cases).includes('FORBIDDEN_KEY:observedIntent'));
  assert.ok(receiptIssues({ questionLength: 12 }, cases).includes('FORBIDDEN_KEY:questionLength'));
});

test('no live mode: unknown commands/flags are usage errors; the package reads no environment and has no network path', () => {
  for (const args of [['live'], ['all', '--live'], ['harness', '--write-receipt'], [], ['all', '--write-receipt', '--write-receipt']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
  }
  for (const [name, text] of sources) {
    assert.ok(!/process\.env/.test(text), `${name} reads no environment`);
    assert.ok(!/OPENAI_API_KEY|ATLAS_ASK_REMOTE_|productionSeams|remote\/secret\.ts|remote\/dispatch\.ts|['"]Authorization['"]/.test(text), `${name} has no credential/dispatch path`);
  }
  const network = sources.filter(([, t]) => /from 'node:(https?|http2|net|tls|dgram|dns)'/.test(t)).map(([n]) => n).sort();
  assert.deepEqual(network, ['commands.ts', 'net-guard.ts'], 'only the guard and its self-test touch network modules');
  const entry = readFileSync(new URL('cli.ts', scriptDir), 'utf8').split('\n').filter(l => /^import /.test(l));
  assert.deepEqual(entry, ["import { installNetworkGuard } from './net-guard.ts';"], 'guard first; everything else is a dynamic import after install');
});
