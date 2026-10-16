// DEV-16-AC02: one synthetic 500-customer billing run; never sends to a real accounting provider.
// k6 run --log-format=json --console-output=billing-protocol.jsonl -e DATASET_MANIFEST=/absolute/dataset.json \
//   -e SUMMARY_PATH=/absolute/billing-summary.json tools/load-test/billing.js
// Collect is labelled synchronous unless the actual trigger returns 202. Export is observed through authoritative bases.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { billingBasesMatch, latencySample, validateBilling, validateManifest } from './workday-contract.mjs';

if (!__ENV.DATASET_MANIFEST) throw new Error('DATASET_MANIFEST is required.');
const manifest = validateManifest(JSON.parse(open(__ENV.DATASET_MANIFEST)), { baseUrl: __ENV.BASE_URL, allowRemote: __ENV.ALLOW_REMOTE_TEST === '1' });
const billing = validateBilling(manifest);
const baseUrl = manifest.baseUrl.replace(/\/$/, '');
const finance = manifest.auth.users.find((u) => u.role === 'Crm.Finance');
const management = manifest.auth.users.find((u) => u.role === 'Crm.Management');
const collectLimitMs = 300000;
const exportLimitMs = 1800000;
const httpMs = new Trend('billing_http_ms', true);
const collectMs = new Trend('billing_collect_ms', true);
const exportMs = new Trend('billing_export_ms', true);
const collectCompleted = new Counter('billing_collect_completed');
const exportCompleted = new Counter('billing_export_completed');
const failures = new Counter('billing_protocol_failures');
const asynchronousCollect = new Gauge('billing_collect_returned_202');

export const options = {
  scenarios: { billing: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '40m' } },
  noCookiesReset: true,
  insecureSkipTLSVerify: __ENV.ALLOW_LOCAL_TLS === '1',
  systemTags: ['status', 'method', 'name', 'check', 'error', 'error_code', 'expected_response'],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: { billing_collect_ms: ['max<=300000'], billing_export_ms: ['max<=1800000'],
    billing_collect_completed: ['count==1'], billing_export_completed: ['count==1'],
    billing_protocol_failures: ['count==0'], http_req_failed: ['rate==0'], checks: ['rate==1'] },
};

const json = (response) => { try { return response.json(); } catch { return null; } };
function protocol(stage, details) { console.log(JSON.stringify({ schemaVersion: 1, kind: 'billing-protocol', datasetId: manifest.datasetId, datasetChecksum: manifest.datasetChecksum, at: new Date().toISOString(), stage, ...details })); }
function requireCheck(value, name) { if (!check(value, { [name]: Boolean })) throw new Error(name); }
function request(method, name, path, body, { etag, expected = [200], timeoutMs = 30000 } = {}) {
  const start = Date.now();
  let response;
  try {
    response = http.request(method, `${baseUrl}${path}`, body === undefined ? null : JSON.stringify(body), {
      redirects: 0, timeout: `${timeoutMs}ms`, tags: { name }, responseCallback: http.expectedStatuses(...expected),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF': '1', ...(etag ? { 'If-Match': etag } : {}) },
    });
  } catch { /* Recorded below with the same latency/check treatment as every other failed request. */ }
  httpMs.add(latencySample(response, Date.now() - start, timeoutMs), { operation: name });
  const valid = Boolean(response && expected.includes(response.status));
  if (!valid) protocol('http-error', { operation: name, status: response?.status ?? 0, elapsedMs: Date.now() - start, code: json(response)?.code ?? null });
  requireCheck(valid, `${name}: expected response`);
  return response;
}
function signIn(user) {
  requireCheck(Boolean(user), 'required synthetic identity exists');
  request('GET', 'development sign-in', user.loginPath, undefined, { expected: [302] });
  const me = json(request('GET', 'verify synthetic identity', '/bff/user'));
  requireCheck(me?.id === user.userId && me.authMode === 'Development' && me.roles?.includes(user.role), 'signed-in identity matches manifest');
}
function readRun(id, timeoutMs) {
  const result = json(request('GET', 'read billing run', `/api/v1/billing/runs/${id}`, undefined, { timeoutMs: Math.min(30000, Math.max(1000, timeoutMs ?? 30000)) }));
  requireCheck(Boolean(result?.id === id && result?.etag), 'billing run has identity and ETag');
  return result;
}
function command(id, action, timeoutMs = 30000, expected = [200]) {
  const run = readRun(id, timeoutMs);
  return request('POST', `billing ${action}`, `/api/v1/billing/runs/${id}/${action}`, {}, { etag: run.etag, expected, timeoutMs });
}

export default function collectAndExport() {
  collectCompleted.add(0); exportCompleted.add(0); failures.add(0);
  let runId = null;
  let collectStart = null;
  let exportStart = null;
  let collectRecorded = false;
  let exportRecorded = false;
  try {
    signIn(finance);
    const created = json(request('POST', 'create billing run', '/api/v1/billing/runs', { year: billing.year, month: billing.month, notes: `DEV16 synthetic ${manifest.datasetId}` }, { expected: [201] }));
    requireCheck(Boolean(created?.id && created?.etag), 'new run has identity and ETag');
    runId = created.id;
    protocol('created', { runId, year: billing.year, month: billing.month, expectedCustomers: 500, provider: manifest.provider });
    collectStart = Date.now();
    const trigger = request('POST', 'billing collect', `/api/v1/billing/runs/${runId}/collect`, {}, { etag: created.etag, expected: [200, 202], timeoutMs: collectLimitMs });
    asynchronousCollect.add(trigger.status === 202 ? 1 : 0);
    protocol('collect-trigger', { runId, httpStatus: trigger.status, mode: trigger.status === 202 ? 'asynchronous accepted request' : 'synchronous response', elapsedMs: Date.now() - collectStart });
    let run = json(trigger);
    while (run?.status !== 'Collected' && Date.now() - collectStart < collectLimitMs) {
      sleep(1);
      run = readRun(runId, collectLimitMs - (Date.now() - collectStart));
      if (run.collection?.status === 'Failed') throw new Error('Background billing collection failed');
    }
    const bases = json(request('GET', 'verify collected bases', `/api/v1/billing/runs/${runId}/bases`));
    const collectedElapsed = Date.now() - collectStart;
    collectMs.add(collectedElapsed); collectRecorded = true;
    requireCheck(run?.status === 'Collected' && collectedElapsed <= collectLimitMs, '500-customer collection completed within 300 seconds');
    requireCheck(billingBasesMatch(bases, billing.customerIds), 'collected bases match exactly 500 seeded customers');
    requireCheck(run.organizations === 500 && run.conflicts === 0, 'run reports 500 customers and no unresolved conflicts');
    collectCompleted.add(1);
    protocol('collected', { runId, elapsedMs: collectedElapsed, organizations: bases.length, mode: trigger.status === 202 ? 'async' : 'sync', withAnomalies: run.withAnomalies });
    // A long collect may exceed privileged confirmation freshness. The existing dev-login refreshes only this synthetic session.
    signIn(finance);
    exportStart = Date.now();
    const approved = json(command(runId, 'approve'));
    requireCheck(['Approved', 'InReview'].includes(approved?.status), 'approval returned the reviewed run state');
    if (approved?.requiresSecondApproval && approved.status !== 'Approved') {
      requireCheck(Boolean(management && management.userId !== finance.userId), 'second approval has a distinct Management identity');
      signIn(management);
      command(runId, 'second-approve');
      signIn(finance);
    }
    // Approval itself queues the immutable bases. A separate export POST could race with a fast mock completion.
    run = readRun(runId);
    while (run.exported !== 500 && Date.now() - exportStart < exportLimitMs) {
      if (run.failed > 0 || run.status === 'ExportedWithErrors') throw new Error('Export reported failed or unresolved bases; retries are not silently included');
      sleep(2);
      run = readRun(runId, exportLimitMs - (Date.now() - exportStart));
    }
    const exported = json(request('GET', 'verify exported bases', `/api/v1/billing/runs/${runId}/bases`));
    const elapsed = Date.now() - exportStart;
    exportMs.add(elapsed); exportRecorded = true;
    requireCheck(elapsed <= exportLimitMs && run.exported === 500 && run.failed === 0, '500-customer export completed within 1800 seconds');
    requireCheck(billingBasesMatch(exported, billing.customerIds, true), 'every seeded customer has one Exported basis with an external order receipt');
    exportCompleted.add(1);
    protocol('exported', { runId, elapsedMs: elapsed, exported: 500, failed: 0, status: run.status, provider: manifest.provider });
  } catch (error) {
    failures.add(1);
    check(false, { 'billing workflow completed without a protocol error': Boolean });
    if (collectStart !== null && !collectRecorded) collectMs.add(Math.max(Date.now() - collectStart, collectLimitMs));
    if (exportStart !== null && !exportRecorded) exportMs.add(Math.max(Date.now() - exportStart, exportLimitMs));
    protocol('failed', { runId, error: error.message, collectElapsedMs: collectStart === null ? null : Date.now() - collectStart, exportElapsedMs: exportStart === null ? null : Date.now() - exportStart });
  }
}

export function handleSummary(data) {
  const report = { schemaVersion: 1, kind: 'crm-billing-500', datasetId: manifest.datasetId, datasetChecksum: manifest.datasetChecksum,
    datasetProfile: manifest.profile, counts: manifest.counts, seed: manifest.seed, billing: { year: billing.year, month: billing.month, expectedCustomers: 500 },
    provider: manifest.provider, protocol: 'JSON console messages contain stage, runId, actual collect response mode, timings and errors. Run with --log-format=json --console-output=<file>.',
    thresholds: { collectMs: collectLimitMs, exportMs: exportLimitMs }, errorSamplesIncluded: true,
    metrics: data.metrics, checks: data.root_group, thresholdsPassed: Object.values(data.metrics).every((m) => !m.thresholds || Object.values(m.thresholds).every((t) => t.ok)) };
  const content = JSON.stringify(report, null, 2);
  return { [__ENV.SUMMARY_PATH ?? 'billing-summary.json']: content, stdout: `${content}\n` };
}
