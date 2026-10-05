import test from 'node:test';
import assert from 'node:assert/strict';
import { billingBasesMatch, validateBilling, concurrentUpdatePassed, durationSeconds, latencySample, summarizeBrowser, TARGET_COUNTS, userForVu, validateManifest } from './workday-contract.mjs';

const manifest = () => ({
  schemaVersion: 1, profile: 'smoke', seed: 1616, datasetId: 'dev16-smoke', datasetChecksum: `sha256:${'a'.repeat(64)}`,
  baseUrl: 'https://localhost:5182', database: { name: 'crm_load_dev16_smoke', syntheticMarker: 'DEV16:dev16-smoke' },
  counts: { organizations: 50, contacts: 50, tickets: 100, timeEntries: 100, auditEntries: 100 }, provider: { mode: 'simulated' },
  organizations: [{ id: '00000001-0000-0000-0000-000000000001', name: 'DEV16 Organization 1', searchTerm: 'DEV16 Organization 1' }],
  auth: { mode: 'Development', environment: 'Development', users: [
    { role: 'Crm.Sales', userId: '00000001-0000-0000-0000-000000000010', weight: 2, loginPath: '/bff/dev-login?role=Crm.Sales&returnUrl=/' },
    { role: 'Crm.Technician', userId: '00000001-0000-0000-0000-000000000011', weight: 1, loginPath: '/bff/dev-login?role=Crm.Technician&returnUrl=/' },
  ] },
});

test('requires matching ownership, exact target and the existing non-production harness before requests', () => {
  assert.equal(validateManifest(manifest()).datasetId, 'dev16-smoke');
  assert.throws(() => validateManifest({ ...manifest(), database: { name: 'crm_prod', syntheticMarker: 'DEV16:dev16-smoke' } }), /isolated/);
  assert.throws(() => validateManifest(manifest(), { baseUrl: 'https://localhost:5181' }), /BASE_URL/);
  assert.throws(() => validateManifest({ ...manifest(), auth: { ...manifest().auth, environment: 'Production' } }), /Development/);
  assert.throws(() => validateManifest({ ...manifest(), provider: { mode: 'real' } }), /simulated/);
  assert.throws(() => validateManifest({ ...manifest(), baseUrl: 'https://example.test' }), /ALLOW_REMOTE_TEST/);
  assert.throws(() => validateManifest({ ...manifest(), auth: { ...manifest().auth, users: [{ ...manifest().auth.users[0], loginPath: 'https://example.test/sign-in' }] } }), /loginPath/);
});

test('a small manifest cannot claim the full target volumes and role selection is deterministic', () => {
  assert.throws(() => validateManifest({ ...manifest(), profile: 'full' }), /full profile/);
  assert.equal(validateManifest({ ...manifest(), profile: 'full', counts: { ...TARGET_COUNTS } }).profile, 'full');
  assert.deepEqual([1, 2, 3, 4].map((id) => userForVu(manifest(), id).role), ['Crm.Sales', 'Crm.Sales', 'Crm.Technician', 'Crm.Sales']);
  assert.equal(durationSeconds('30m'), 1800);
  assert.throws(() => durationSeconds('0s'), /positive/);
});

test('timeouts, transport errors and forbidden reads remain measurable; conflicts need one winner', () => {
  assert.equal(latencySample({ status: 0, timings: { duration: 0 } }, 5000, 30000), 30000);
  assert.equal(latencySample(null, 40000, 30000), 40000);
  assert.equal(latencySample({ status: 403, timings: { duration: 300 } }, 350), 350);
  assert.equal(concurrentUpdatePassed([{ status: 200 }, { status: 412 }]), true);
  for (const statuses of [[200, 200], [412, 412], [200, 403], [200, 0]]) assert.equal(concurrentUpdatePassed(statuses.map((status) => ({ status }))), false);
});

test('browser errors and missing paints count in percentiles and fail the browser gate', () => {
  const samples = [{ firstUsefulMs: 1000, lcpMs: 1200, elapsedMs: 5000, errors: [] }, { firstUsefulMs: null, lcpMs: null, elapsedMs: 30000, errors: ['timeout'] }];
  const summary = summarizeBrowser(samples, 30000);
  assert.equal(summary.firstUsefulMs.samples, 2);
  assert.equal(summary.firstUsefulMs.p95, 30000);
  assert.equal(summary.lcpMs.p95, 30000);
  assert.equal(summary.failedSamples, 1);
  assert.equal(summary.passed, false);
  assert.equal(summarizeBrowser(samples.slice(0, 1), 30000).passed, true);
});


test('billing validates the fixed 500-customer experiment and rejects partial or duplicate export receipts', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `00000001-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const data = manifest();
  data.auth.users.push({ role: 'Crm.Finance', userId: '00000001-0000-0000-0000-000000000012', weight: 1, loginPath: '/bff/dev-login?role=Crm.Finance&returnUrl=/' });
  data.billing = { year: 2026, month: 9, customerIds: ids };
  assert.equal(validateBilling(data).customerIds.length, 500);
  assert.throws(() => validateBilling({ ...data, billing: { ...data.billing, customerIds: ids.slice(1) } }), /500/);
  const bases = ids.map((id) => ({ organization: { id }, status: 'Exported', orderNo: `mock-${id}`, exportedAt: '2026-10-04T00:00:00Z' }));
  assert.equal(billingBasesMatch(bases, ids, true), true);
  assert.equal(billingBasesMatch(bases.slice(1), ids, true), false);
  assert.equal(billingBasesMatch([...bases.slice(1), bases[1]], ids, true), false);
  assert.equal(billingBasesMatch([{ ...bases[0], status: 'Failed' }, ...bases.slice(1)], ids, true), false);
  assert.equal(billingBasesMatch([{ ...bases[0], orderNo: null }, ...bases.slice(1)], ids, true), false);
});
