// DEV-16: deterministic synthetic CRM workday. Requires the seed manifest; never run against operational data.
// k6 run -e DATASET_MANIFEST=/absolute/dataset.json -e SUMMARY_PATH=/absolute/workday.json tools/load-test/workday.js
import http from 'k6/http';
import exec from 'k6/execution';
import { check, group, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { concurrentUpdatePassed, durationSeconds, latencySample, userForVu, validateManifest } from './workday-contract.mjs';

if (!__ENV.DATASET_MANIFEST) throw new Error('DATASET_MANIFEST is required; seed an isolated synthetic database first.');
const manifest = validateManifest(JSON.parse(open(__ENV.DATASET_MANIFEST)), { baseUrl: __ENV.BASE_URL, allowRemote: __ENV.ALLOW_REMOTE_TEST === '1' });
const baseUrl = manifest.baseUrl.replace(/\/$/, '');
const seededOrganizations = new Map(manifest.organizations.map((organization) => [organization.id, organization.name]));
const timePeriod = manifest.history?.readPeriod ?? manifest.billing;
if (!timePeriod || !Number.isInteger(timePeriod.year) || timePeriod.year < 2000 || timePeriod.year > 2100 ||
  !Number.isInteger(timePeriod.month) || timePeriod.month < 1 || timePeriod.month > 12) {
  throw new Error('history.readPeriod or billing must declare a valid fixed year/month for historical time reads.');
}
const timeDatePrefix = `${timePeriod.year}-${String(timePeriod.month).padStart(2, '0')}-`;
const guidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const vus = Number(__ENV.VUS ?? (manifest.profile === 'full' ? 50 : 5));
const duration = __ENV.DURATION ?? (manifest.profile === 'full' ? '30m' : '30s');
const warmup = __ENV.WARMUP ?? (manifest.profile === 'full' ? '2m' : '5s');
const timeoutMs = Number(__ENV.REQUEST_TIMEOUT_MS ?? 30000);
if (!Number.isInteger(vus) || vus < 1 || (manifest.profile === 'full' && vus < 50)) throw new Error('VUS must be positive; a full profile needs at least 50 concurrent sessions.');
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('REQUEST_TIMEOUT_MS must be 1000–60000.');
const durationSecondsValue = durationSeconds(duration);
const warmupSeconds = durationSeconds(warmup);
const drainSeconds = Math.ceil(timeoutMs / 1000) + 2;
const readTrend = new Trend('crm_read_ms', true);
const writeTrend = new Trend('crm_write_ms', true);
const searchTrend = new Trend('crm_search_ms', true);
const conflictTrend = new Trend('crm_conflict_ms', true);
const operationErrors = new Rate('crm_operation_failed');
const attempted = new Counter('crm_operation_attempts');
const expectedConflicts = new Counter('crm_expected_conflicts');
const completedWorkdays = new Counter('crm_completed_workdays');
const activeIteration = new Gauge('crm_active_iteration');
const iterationsStarted = new Counter('crm_iterations_started');
const iterationsFinished = new Counter('crm_iterations_finished');

export const options = {
  scenarios: {
    warmup: { executor: 'constant-vus', vus, duration: warmup, gracefulStop: `${drainSeconds}s`, tags: { phase: 'warmup' } },
    measure: { executor: 'constant-vus', vus, duration, startTime: `${warmupSeconds + drainSeconds}s`, gracefulStop: `${drainSeconds}s`, tags: { phase: 'measure' } },
  },
  noCookiesReset: true,
  insecureSkipTLSVerify: __ENV.ALLOW_LOCAL_TLS === '1',
  systemTags: ['status', 'method', 'name', 'group', 'check', 'error', 'error_code', 'scenario', 'expected_response'],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    ...Object.fromEntries(['warmup', 'measure'].flatMap((phase) => Array.from({ length: vus }, (_, index) =>
      [`crm_active_iteration{phase:${phase},client_id:${index + 1}}`, ['value==0']]))),
    'crm_read_ms{phase:measure}': ['p(95)<=500'],
    'crm_write_ms{phase:measure}': ['p(95)<=1000'],
    'crm_search_ms{phase:measure}': ['p(95)<=1000'],
    'crm_operation_failed{phase:measure}': ['rate==0'],
    'http_req_failed{phase:measure}': ['rate==0'],
    'checks{phase:measure}': ['rate==1'],
    'crm_operation_attempts{phase:measure,kind:read}': ['count>0'],
    'crm_operation_attempts{phase:measure,kind:write}': ['count>0'],
    'crm_operation_attempts{phase:measure,kind:search}': ['count>0'],
    'crm_expected_conflicts{phase:measure}': ['count>0'],
    'crm_completed_workdays{phase:measure}': ['count>0'],
  },
};

let signedIn = null;
let currentPhase = 'setup';
let phaseDeadline = Infinity;
const phaseComplete = {};
function beforeRequest() { if (Date.now() >= phaseDeadline) throw phaseComplete; }
const phase = () => currentPhase;
const json = (response) => { try { return response.json(); } catch { return null; } };
const headers = (etag) => ({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF': '1', ...(etag ? { 'If-Match': etag } : {}) });
const params = (name, expected = [200], etag) => ({ timeout: `${timeoutMs}ms`, redirects: 0, headers: headers(etag), tags: { name, phase: phase() }, responseCallback: http.expectedStatuses(...expected) });

function record(response, elapsed, kind, name, expected = [200]) {
  const tags = { phase: phase(), kind, operation: name };
  const trend = kind === 'search' ? searchTrend : kind === 'write' ? writeTrend : readTrend;
  trend.add(latencySample(response, elapsed, timeoutMs), tags);
  attempted.add(1, tags);
  const success = Boolean(response && expected.includes(response.status));
  operationErrors.add(!success, tags);
  check(response, { [`${name}: expected business response`]: () => success }, { phase: phase() });
  return response;
}

function request(method, name, path, body, kind = 'read', expected = [200], etag) {
  beforeRequest();
  const start = Date.now();
  let response = null;
  try { response = http.request(method, `${baseUrl}${path}`, body === undefined ? null : JSON.stringify(body), params(name, expected, etag)); }
  catch { /* The missing response is recorded as a failed timeout-sized sample, not skipped. */ }
  record(response, Date.now() - start, kind, name, expected);
  // End this interaction after a failed request. The next iteration retries as a new interaction; the failed sample stays.
  // The deadline guard prevents starting another request in the phase's graceful drain window.
  if (!response || !expected.includes(response.status)) throw new Error(`${name}: unexpected HTTP status ${response?.status ?? 0}`);
  return response;
}

function signIn(user) {
  beforeRequest();
  const response = http.get(`${baseUrl}${user.loginPath}`, params('auth: development sign-in', [302]));
  if (response.status !== 302) {
    check(false, { 'synthetic sign-in succeeded': Boolean }, { phase: phase() });
    exec.test.abort('Development sign-in failed before workload start.');
  }
  beforeRequest();
  const meResponse = http.get(`${baseUrl}/bff/user`, params('auth: verify identity'));
  const me = json(meResponse);
  const valid = response.status === 302 && meResponse.status === 200 && me?.id === user.userId && me?.authMode === 'Development' && me?.roles?.includes(user.role);
  check(valid, { 'synthetic identity and Development auth verified': (ok) => ok }, { phase: phase() });
  if (!valid) exec.test.abort('The isolated authentication harness did not return the manifest identity.');
  return { userId: user.userId, permissions: me.permissions ?? [] };
}

export function setup() {
  // Fail before applying load if the manifest does not describe this deployment. Cookies are not exported or written.
  for (const user of manifest.auth.users.filter((u) => u.weight > 0)) signIn(user);
  return { datasetId: manifest.datasetId };
}

export default function workday() {
  currentPhase = exec.scenario.name === 'measure' ? 'measure' : 'warmup';
  phaseDeadline = exec.scenario.startTime + (currentPhase === 'measure' ? durationSecondsValue : warmupSeconds) * 1000;
  const tags = { phase: currentPhase, client_id: String(exec.vu.idInTest) };
  iterationsStarted.add(1, tags);
  activeIteration.add(1, tags);
  try { performWorkday(); }
  catch (error) { if (error !== phaseComplete) throw error; }
  finally { activeIteration.add(0, tags); iterationsFinished.add(1, tags); }
}

function performWorkday() {
  const vu = exec.vu.idInTest;
  const user = userForVu(manifest, vu);
  if (!signedIn || signedIn.userId !== user.userId) signedIn = signIn(user);
  const can = (permission) => signedIn.permissions.includes(permission);
  const org = manifest.organizations[(manifest.seed + vu + exec.vu.iterationInScenario * 17) % manifest.organizations.length];
  const get = (name, path, kind) => request('GET', name, path, undefined, kind);
  group('my day and customer card', () => {
    get('notifications', '/api/v1/notifications?unreadOnly=true&limit=15');
    get('contract reminders', '/api/v1/contracts/reminders?mine=true&limit=25');
    const list = json(get('organizations', '/api/v1/customers/organizations?limit=25'));
    // The keyset API deliberately omits an expensive total count; verify the returned business records instead.
    check(list, { 'organization list has seeded business records': (value) => Array.isArray(value?.items) && value.items.length > 0 && value.items.every((item) => seededOrganizations.get(item.id) === item.name) }, { phase: phase() });
    const card = json(get('organization card', `/api/v1/customers/organizations/${org.id}`));
    check(card, { 'customer card matches the seeded identity': (value) => value?.id === org.id && value?.name === org.name }, { phase: phase() });
    get('customer contacts', `/api/v1/customers/organizations/${org.id}/contacts?limit=25`);
    get('customer contracts', `/api/v1/contracts?organizationId=${org.id}&limit=25`);
    get('service summary', `/api/v1/service/organizations/${org.id}/summary`);
    get('customer tickets', `/api/v1/service/tickets?organizationId=${org.id}&limit=25`);
    get('subscriptions', `/api/v1/licensing/subscriptions?organizationId=${org.id}&limit=25`);
    if (can('billing.read')) get('customer invoices', `/api/v1/billing/invoices?organizationId=${org.id}&limit=25`);
  });
  group('search, reports and time', () => {
    const result = json(get('global search', `/api/v1/search?q=${encodeURIComponent(org.searchTerm)}&take=20`, 'search'));
    check(result, { 'search returns seeded organizations': (value) => value?.groups?.some((g) => g.group === 'organizations' && g.items.length > 0) === true }, { phase: phase() });
    get('sales pipeline', '/api/v1/sales/pipeline');
    if (can('reports.read')) {
      const dashboard = json(get('dashboard', '/api/v1/reports/dashboard?months=6'));
      check(dashboard, { 'dashboard returns business panels': (value) => Boolean(value?.recurring && value?.service && value?.licenses) }, { phase: phase() });
    }
    if (can('time.read')) {
      // Seeded history has no synthetic signed-in TechnicianId. Read the whole period so this exercises real rows and allocations.
      const entries = json(get('historical time entries with allocations', `/api/v1/time/entries?year=${timePeriod.year}&month=${timePeriod.month}&limit=25`));
      check(entries, { 'historical time page contains dated business hours and allocations': (value) =>
        Array.isArray(value?.items) && value.items.length > 0 && value.items.length <= 25 && value.totalCount >= value.items.length &&
        Number.isFinite(value.summary?.hours) && value.summary.hours > 0 &&
        value.items.every((entry) => guidPattern.test(entry.id) && seededOrganizations.has(entry.organizationId) &&
          typeof entry.workDate === 'string' && entry.workDate.startsWith(timeDatePrefix) &&
          Number.isFinite(entry.hours) && entry.hours > 0 && typeof entry.etag === 'string' && entry.etag.length > 0 &&
          Array.isArray(entry.allocations) && entry.allocations.length > 0 &&
          entry.allocations.every((allocation) => Number.isFinite(allocation.hours) && allocation.hours > 0 && Number.isFinite(allocation.billedHours) && allocation.billedHours >= 0) &&
          Math.abs(entry.allocations.reduce((total, allocation) => total + allocation.hours, 0) - entry.hours) < 0.0001) }, { phase: phase() });
    } else if (can('time.own')) {
      // The manifest uses shared Development role identities; imported historical rows intentionally belong to external technicians.
      const entries = json(get('time entries: empty-own-list profile', `/api/v1/time/entries?mine=true&year=${timePeriod.year}&month=${timePeriod.month}&limit=25`));
      check(entries, { 'synthetic own-time profile returns an explicit empty page': (value) => Array.isArray(value?.items) && value.items.length === 0 && value.totalCount === 0 && value.summary?.hours === 0 }, { phase: phase() });
    }
  });
  if (can('activities.write')) group('record a note and resolve concurrent edits', () => {
    const body = { type: 'Note', organizationId: org.id, opportunityId: null, contractId: null, contactId: null,
      subject: `${manifest.datasetId} VU ${vu} iteration ${exec.vu.iterationInScenario}`, body: 'Synthetic workload note', dueAt: null, priority: 'Normal', assigneeId: null, addToCalendar: false };
    const created = json(request('POST', 'create activity', '/api/v1/activities', body, 'write', [201]));
    const usable = created?.id && created?.etag;
    check(created, { 'created activity returns identity and concurrency token': () => Boolean(usable) }, { phase: phase() });
    if (!usable) return;
    const edited = json(request('PUT', 'edit activity', `/api/v1/activities/${created.id}`, { ...body, body: 'Synthetic note after review' }, 'write', [200], created.etag));
    check(edited, { 'edited activity returns a new version': (value) => Boolean(value?.etag && value.etag !== created.etag) }, { phase: phase() });
    if (!edited?.etag) return;
    beforeRequest();
    const start = Date.now();
    let responses = [];
    try {
      responses = http.batch([0, 1].map((version) => ({ method: 'PUT', url: `${baseUrl}/api/v1/activities/${created.id}`,
        body: JSON.stringify({ ...body, body: `Concurrent synthetic edit ${version}` }), params: params('concurrent activity edit', [200, 412], edited.etag) })));
    } catch { /* Both attempted edits still receive latency/error samples. */ }
    const elapsed = Date.now() - start;
    for (let i = 0; i < 2; i++) {
      // One batch wall time is a conservative client latency upper bound for each parallel response; no error is omitted.
      record(responses[i], elapsed, 'write', 'concurrent activity edit', [200, 412]);
      conflictTrend.add(latencySample(responses[i], elapsed, timeoutMs), { phase: phase() });
      if (responses[i]?.status === 412) expectedConflicts.add(1, { phase: phase() });
    }
    check(responses, { 'exactly one concurrent edit wins and one gets 412': concurrentUpdatePassed }, { phase: phase() });
  });
  completedWorkdays.add(1, { phase: phase() });
  // Deterministic reading/thinking time, 2–4 seconds, independent of provider or database speed.
  sleep(Math.min(2 + ((manifest.seed + vu + exec.vu.iterationInScenario) % 3), Math.max(0, phaseDeadline - Date.now()) / 1000));
}

export function handleSummary(data) {
  const started = data.metrics.crm_iterations_started?.values.count ?? 0;
  const finished = data.metrics.crm_iterations_finished?.values.count ?? 0;
  const interruptedIterations = Math.max(0, started - finished);
  const report = {
    schemaVersion: 1, kind: 'crm-workday', createdAt: new Date().toISOString(), datasetId: manifest.datasetId,
    datasetChecksum: manifest.datasetChecksum, datasetProfile: manifest.profile, counts: manifest.counts, seed: manifest.seed,
    workload: { concurrentSessions: vus, distinctRoleIdentities: new Set(manifest.auth.users.filter((u) => u.weight > 0).map((u) => u.userId)).size,
      identityLimitation: 'Virtual users have independent cookie sessions but share the manifest Development role identities; the harness supports at most seven distinct role identities and does not measure Entra sign-in.',
      timeEntryProfile: { year: timePeriod.year, month: timePeriod.month, periodSource: manifest.history?.readPeriod ? 'history.readPeriod' : 'billing',
        readableHistory: 'time.read roles query a global page of dated entries including allocations', ownOnly: 'time.own-only roles query an explicitly empty own list; seeded imported technicians have no signed-in user identity' },
      duration, warmup, drainSeconds, timeoutMs, provider: manifest.provider, errorSamplesIncluded: true,
      interruptedIterations, interruptionAccounting: 'Started minus finished iteration counters; each phase/VU active-iteration gauge must end at zero. k6 1.3 does not expose exec.instance in handleSummary.',
      clientLatency: 'Sequential requests use wall time. Each concurrent response conservatively uses the elapsed wall time of its two-request batch. Transport failures without timings are censored at REQUEST_TIMEOUT_MS.' },
    metrics: data.metrics, checks: data.root_group, thresholdsPassed: interruptedIterations === 0 && Object.values(data.metrics).every((m) => !m.thresholds || Object.values(m.thresholds).every((t) => t.ok)),
  };
  const content = JSON.stringify(report, null, 2);
  return { [__ENV.SUMMARY_PATH ?? 'workday-summary.json']: content, stdout: `${content}\n` };
}
