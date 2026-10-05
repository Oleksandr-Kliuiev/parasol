// Run with: node --experimental-vm-modules --test tools/load-test/workday-runtime.test.mjs
// Executes the actual k6 scenario with in-process HTTP/metric substitutes; no service or provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const organization = { id: '00000001-0000-0000-0000-000000000001', name: 'DEV16 Seeded Organization', searchTerm: 'DEV16 Seeded Organization' };
const identity = { role: 'Crm.Finance', userId: '00000001-0000-0000-0000-000000000011', weight: 1, loginPath: '/bff/dev-login?role=Crm.Finance&returnUrl=/' };
const timeEntry = { id: '16160005-0000-0000-0000-000000000001', source: 'Atera', organizationId: organization.id, organizationName: organization.name,
  technicianId: null, technicianName: 'Synthetic technician', workDate: '2026-09-30', hours: 1.25, status: 'Invoiced', etag: '"time-one"',
  allocations: [{ classification: 'Rate', hours: 1.25, billedHours: 1.25, rate: 1000, amount: 1250, hourBankId: null }] };
const fixture = { schemaVersion: 1, profile: 'smoke', seed: 1616, datasetId: 'dev16-runtime-test', datasetChecksum: `sha256:${'b'.repeat(64)}`,
  baseUrl: 'https://localhost:5182', database: { name: 'crm_load_dev16_test', syntheticMarker: 'DEV16:dev16-runtime-test' },
  counts: { organizations: 500, contacts: 5000, tickets: 10000, timeEntries: 10000, auditEntries: 100000 },
  billing: { year: 2026, month: 9 },
  organizations: [organization], auth: { mode: 'Development', environment: 'Development', users: [identity] }, provider: { mode: 'simulated' } };

async function scenario({ forbidden = false, timeout = false, race = [200, 412], timePermission = 'time.read', historicalItems = [timeEntry], history, billing = fixture.billing, advanceAfter } = {}) {
  const measurements = new Map();
  const checks = [];
  const sent = [];
  const authSent = [];
  let clockMs = 10000;
  class ScenarioDate extends Date { static now() { return clockMs; } }
  const advance = (name) => { if (name === advanceAfter) clockMs += 1100; };
  class Metric { constructor(name) { this.values = []; measurements.set(name, this.values); } add(value, tags) { this.values.push({ value, tags }); } }
  const response = (status, body, duration = 10) => ({ status, json: () => body, timings: { duration } });
  const http = {
    expectedStatuses: (...statuses) => statuses,
    get: (url) => { authSent.push(url); advance(url.includes('/dev-login?') ? 'auth: development sign-in' : 'auth: verify identity'); return url.includes('/dev-login?') ? response(302, null) : response(200, { id: identity.userId, roles: [identity.role], authMode: 'Development', permissions: ['billing.read', 'reports.read', timePermission, 'activities.write'] }); },
    request: (method, url, body, params) => {
      sent.push({ method, url, body, params });
      advance(params.tags.name);
      if (params.tags.name === 'organization card' && timeout) throw new Error('Synthetic transport timeout');
      if (params.tags.name === 'organization card' && forbidden) return response(403, { code: 'FORBIDDEN' }, 432);
      if (method === 'POST') return response(201, { id: 'activity-1', etag: '"one"' });
      if (method === 'PUT') return response(200, { id: 'activity-1', etag: '"two"' });
      if (url.includes('/organizations?')) return response(200, { items: [organization], nextCursor: 'next-page' });
      if (url.endsWith(`/organizations/${organization.id}`)) return response(200, organization);
      if (url.includes('/search?')) return response(200, { groups: [{ group: 'organizations', items: [organization] }] });
      if (url.includes('/dashboard?')) return response(200, { recurring: {}, service: {}, licenses: {} });
      if (url.includes('/time/entries?')) {
        const items = url.includes('mine=true') ? [] : historicalItems;
        const hours = items.reduce((total, entry) => total + entry.hours, 0);
        return response(200, { items, summary: { hours, billableHours: hours, approvedHours: hours, newHours: 0, amount: hours * 1000 }, periodClosed: false, nextCursor: null, totalCount: items.length });
      }
      return response(200, { items: [], totalCount: 0 });
    },
    batch: (requests) => { sent.push(...requests); advance('concurrent activity edit'); return race.map((status) => response(status, {})); },
  };
  const context = createContext({ __ENV: { DATASET_MANIFEST: '/synthetic.json', VUS: '1', DURATION: '1s', WARMUP: '1s' }, open: () => JSON.stringify({ ...fixture, history, billing }), console, Date: ScenarioDate });
  const fakeCheck = (value, rules, tags) => Object.entries(rules).map(([name, predicate]) => { const passed = predicate(value); checks.push({ name, passed, tags }); return passed; }).every(Boolean);
  const modules = {
    'k6/http': new SyntheticModule(['default'], function () { this.setExport('default', http); }, { context }),
    'k6/execution': new SyntheticModule(['default'], function () { this.setExport('default', { scenario: { name: 'measure', startTime: 10000 }, vu: { idInTest: 1, iterationInScenario: 0 }, test: { abort: (message) => { throw new Error(message); } } }); }, { context }),
    k6: new SyntheticModule(['check', 'group', 'sleep'], function () { this.setExport('check', fakeCheck); this.setExport('group', (_, fn) => fn()); this.setExport('sleep', () => {}); }, { context }),
    'k6/metrics': new SyntheticModule(['Counter', 'Gauge', 'Rate', 'Trend'], function () { this.setExport('Counter', Metric); this.setExport('Gauge', Metric); this.setExport('Rate', Metric); this.setExport('Trend', Metric); }, { context }),
    './workday-contract.mjs': new SourceTextModule(await readFile(new URL('./workday-contract.mjs', import.meta.url), 'utf8'), { context }),
  };
  const script = new SourceTextModule(await readFile(new URL('./workday.js', import.meta.url), 'utf8'), { context });
  await script.link((name) => modules[name]);
  await script.evaluate();
  try { script.namespace.default(); } catch (error) { assert.match(error.message, /organization card: unexpected HTTP status/); }
  const summary = JSON.parse(script.namespace.handleSummary({ metrics: {}, root_group: {} })['workday-summary.json']);
  return { measurements, checks, sent, summary, authSent };
}

test('actual workday sends CSRF/If-Match and records both concurrent write responses', async () => {
  const result = await scenario();
  assert.equal(result.checks.every((c) => c.passed), true);
  assert.equal(result.measurements.get('crm_write_ms').length, 4);
  assert.equal(result.measurements.get('crm_conflict_ms').length, 2);
  assert.equal(result.measurements.get('crm_expected_conflicts')[0].value, 1);
  const puts = result.sent.filter((s) => s.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.equal(puts[0].params.headers['If-Match'], '"one"');
  assert.equal(puts[1].params.headers['If-Match'], '"two"');
  assert.equal(puts[2].params.headers['If-Match'], '"two"');
  assert.ok(puts.every((s) => s.params.headers['X-CSRF'] === '1'));
});

test('403 business reads fail checks and remain in the same measured histogram', async () => {
  const result = await scenario({ forbidden: true });
  assert.equal(result.checks.find((c) => c.name === 'organization card: expected business response').passed, false);
  assert.equal(result.measurements.get('crm_read_ms').find((m) => m.tags.operation === 'organization card').value, 432);
  assert.equal(result.measurements.get('crm_operation_failed').find((m) => m.tags.operation === 'organization card').value, true);
});

test('a transport timeout remains a latency sample and a failed check; two racing successes fail concurrency', async () => {
  const result = await scenario({ timeout: true });
  assert.equal(result.measurements.get('crm_read_ms').find((m) => m.tags.operation === 'organization card').value, 30000);
  assert.equal(result.checks.find((c) => c.name === 'organization card: expected business response').passed, false);
  const raceResult = await scenario({ race: [200, 200] });
  assert.equal(raceResult.checks.find((c) => c.name === 'exactly one concurrent edit wins and one gets 412').passed, false);
  assert.equal(raceResult.measurements.get('crm_conflict_ms').length, 2);
});

test('history reads load real September rows and allocations; own-only reads remain explicitly empty', async () => {
  const historical = await scenario();
  const historicalRequest = historical.sent.find((request) => request.url.includes('/time/entries?'));
  assert.equal(historicalRequest.url, 'https://localhost:5182/api/v1/time/entries?year=2026&month=9&limit=25');
  assert.equal(historicalRequest.params.tags.name, 'historical time entries with allocations');
  assert.equal(historical.checks.find((check) => check.name === 'historical time page contains dated business hours and allocations').passed, true);
  const own = await scenario({ timePermission: 'time.own' });
  const ownRequest = own.sent.find((request) => request.url.includes('/time/entries?'));
  assert.ok(ownRequest.url.includes('mine=true'));
  assert.equal(ownRequest.params.tags.name, 'time entries: empty-own-list profile');
  assert.equal(own.checks.every((check) => check.passed), true);
  for (const historicalItems of [[], [{ ...timeEntry, hours: 0 }], [{ ...timeEntry, id: 'invalid' }], [{ ...timeEntry, allocations: [] }]]) {
    const invalid = await scenario({ historicalItems });
    assert.equal(invalid.checks.find((check) => check.name === 'historical time page contains dated business hours and allocations').passed, false);
  }
});

test('an October billing repeat keeps explicit September history reads and reports the actual period source', async () => {
  const explicit = await scenario({ billing: { year: 2026, month: 10 }, history: { readPeriod: { year: 2026, month: 9 } } });
  assert.equal(explicit.checks.every((check) => check.passed), true);
  assert.equal(explicit.sent.find((request) => request.url.includes('/time/entries?')).url, 'https://localhost:5182/api/v1/time/entries?year=2026&month=9&limit=25');
  assert.deepEqual({ year: explicit.summary.workload.timeEntryProfile.year, month: explicit.summary.workload.timeEntryProfile.month, source: explicit.summary.workload.timeEntryProfile.periodSource },
    { year: 2026, month: 9, source: 'history.readPeriod' });
  const fallback = await scenario();
  assert.equal(fallback.summary.workload.timeEntryProfile.periodSource, 'billing');
  assert.equal(fallback.summary.workload.timeEntryProfile.month, 9);
  await assert.rejects(() => scenario({ history: { readPeriod: { year: 2026, month: 13 } } }), /valid fixed year\/month/);
  await assert.rejects(() => scenario({ billing: null }), /valid fixed year\/month/);
});

test('phase deadline drains the last response without another request or a business failure', async () => {
  for (const advanceAfter of ['auth: development sign-in', 'auth: verify identity', 'organization card', 'edit activity', 'concurrent activity edit']) {
    const result = await scenario({ advanceAfter });
    assert.equal(result.checks.every((check) => check.passed), true, advanceAfter);
    assert.deepEqual(result.measurements.get('crm_active_iteration').map((sample) => sample.value), [1, 0]);
    assert.equal(result.measurements.get('crm_iterations_started').length, 1);
    assert.equal(result.measurements.get('crm_iterations_finished').length, 1);
    if (advanceAfter.startsWith('auth:')) {
      assert.equal(result.authSent.length, advanceAfter.endsWith('sign-in') ? 1 : 2);
      assert.equal(result.sent.length, 0);
    } else {
      assert.equal(result.sent.at(-1).params.tags.name, advanceAfter);
      const metric = advanceAfter === 'organization card' ? 'crm_read_ms' : 'crm_write_ms';
      const recorded = result.measurements.get(metric).filter((sample) => sample.tags.operation === advanceAfter);
      assert.equal(recorded.length, advanceAfter === 'concurrent activity edit' ? 2 : 1);
      assert.ok(recorded.every((sample) => sample.value >= 1100));
      if (advanceAfter === 'edit activity') assert.equal(result.measurements.get('crm_conflict_ms').length, 0);
    }
  }
});
