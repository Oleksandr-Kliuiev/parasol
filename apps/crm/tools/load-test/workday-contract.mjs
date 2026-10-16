// Shared by k6, the browser runner and Node tests. No network, credentials or runtime-specific imports.
export const TARGET_COUNTS = Object.freeze({ organizations: 5000, contacts: 50000, tickets: 1000000, timeEntries: 1000000, auditEntries: 10000000 });
const ROLES = ['Crm.Admin', 'Crm.Sales', 'Crm.Technician', 'Crm.ServiceLead', 'Crm.Finance', 'Crm.Management', 'Crm.ReadOnly'];
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function validateManifest(value, { baseUrl, allowRemote = false } = {}) {
  const fail = (message) => { throw new Error(`Invalid synthetic dataset manifest: ${message}`); };
  if (!value || value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!['smoke', 'full'].includes(value.profile)) fail('profile must be smoke or full');
  if (!Number.isSafeInteger(value.seed)) fail('seed must be an integer');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value.datasetId ?? '')) fail('datasetId must be a safe synthetic identifier');
  if (!/^sha256:[\da-f]{64}$/i.test(value.datasetChecksum ?? '')) fail('datasetChecksum must identify the seeded dataset');
  if (!/^crm_load_dev16_[A-Za-z0-9_]+$/.test(value.database?.name ?? '')) fail('database must use the isolated crm_load_dev16_ prefix');
  if (value.database.syntheticMarker !== `DEV16:${value.datasetId}`) fail('synthetic ownership marker does not match datasetId');
  const origin = String(value.baseUrl ?? '').replace(/\/$/, '');
  if (!/^https?:\/\/[^/@?#]+(?::\d+)?$/.test(origin)) fail('baseUrl must be a plain HTTP(S) origin');
  if (baseUrl && baseUrl.replace(/\/$/, '') !== origin) fail('BASE_URL does not match the dataset manifest');
  if (!allowRemote && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) fail('remote execution needs explicit ALLOW_REMOTE_TEST=1');
  if (value.auth?.mode !== 'Development' || value.auth?.environment !== 'Development') fail('only the existing Development sign-in harness is supported');
  if (value.provider?.mode !== 'simulated') fail('external providers must be simulated');
  for (const [name, target] of Object.entries(TARGET_COUNTS)) {
    if (!Number.isSafeInteger(value.counts?.[name]) || value.counts[name] < 0) fail(`counts.${name} must be a non-negative integer`);
    if (value.profile === 'full' && value.counts[name] < target) fail(`full profile needs at least ${target} ${name}`);
  }
  if (!Array.isArray(value.organizations) || value.organizations.length === 0) fail('organizations must contain seeded card targets');
  for (const org of value.organizations) {
    if (!GUID.test(org.id) || typeof org.name !== 'string' || !org.name.trim() || typeof org.searchTerm !== 'string' || org.searchTerm.trim().length < 2) fail('every organization needs id, name and searchTerm');
  }
  if (!Array.isArray(value.auth.users) || !value.auth.users.length) fail('auth.users is required');
  let weight = 0;
  for (const user of value.auth.users) {
    if (!ROLES.includes(user.role) || !GUID.test(user.userId)) fail('auth user must name an existing synthetic role identity');
    if (!Number.isSafeInteger(user.weight) || user.weight < 0 || user.weight > 100) fail('auth weight must be an integer from 0 to 100');
    const path = `/bff/dev-login?role=${user.role}&returnUrl=/`;
    if (user.loginPath !== path && user.loginPath !== path.replace('=/', '=%2F')) fail('loginPath must use only the existing role-based dev-login');
    weight += user.weight;
  }
  if (!weight) fail('at least one auth user must have positive weight');
  return value;
}

export function userForVu(manifest, vu) {
  const weighted = manifest.auth.users.flatMap((user) => Array.from({ length: user.weight }, () => user));
  return weighted[(Math.max(1, vu) - 1) % weighted.length];
}

export function durationSeconds(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (!match) throw new Error('Duration must have one positive numeric value and ms/s/m/h unit');
  const seconds = Number(match[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[match[2]]);
  if (!(seconds > 0)) throw new Error('Duration must be positive');
  return seconds;
}

export function latencySample(response, wallMs, timeoutMs = 30000) {
  // Timeout/error responses stay in the histogram, even when k6 has no HTTP timing to report.
  const measured = Number(response?.timings?.duration);
  if (!response || response.status === 0) return Math.max(Number.isFinite(wallMs) ? wallMs : 0, Number.isFinite(measured) ? measured : 0, timeoutMs);
  return Math.max(Number.isFinite(measured) ? measured : 0, Number.isFinite(wallMs) ? wallMs : 0);
}

export function concurrentUpdatePassed(responses) {
  return responses.length === 2 && responses.filter((r) => r.status === 200).length === 1 && responses.filter((r) => r.status === 412).length === 1;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarizeBrowser(samples, timeoutMs) {
  // Missing observations are right-censored at timeout, not dropped as fast/empty successful loads.
  const useful = samples.map((s) => s.firstUsefulMs ?? Math.max(s.elapsedMs ?? 0, timeoutMs));
  const lcp = samples.map((s) => s.lcpMs ?? Math.max(s.elapsedMs ?? 0, timeoutMs));
  const stats = (values) => ({ samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: values.length ? Math.max(...values) : null });
  return {
    firstUsefulMs: stats(useful), lcpMs: stats(lcp),
    failedSamples: samples.filter((s) => s.errors.length > 0 || s.firstUsefulMs === null || s.lcpMs === null).length,
    passed: samples.length > 0 && samples.every((s) => s.errors.length === 0 && s.firstUsefulMs !== null && s.firstUsefulMs <= 2000 && s.lcpMs !== null && s.lcpMs <= 2500),
  };
}

export function validateBilling(manifest) {
  const billing = manifest.billing;
  if (!billing || !Number.isInteger(billing.year) || billing.year < 2000 || billing.year > 2100 || !Number.isInteger(billing.month) || billing.month < 1 || billing.month > 12) throw new Error('billing needs a fixed supported year/month');
  if (!Array.isArray(billing.customerIds) || billing.customerIds.length !== 500 || new Set(billing.customerIds).size !== 500 || !billing.customerIds.every((id) => GUID.test(id))) throw new Error('billing needs exactly 500 distinct seeded customerIds');
  if (!manifest.auth.users.some((u) => u.role === 'Crm.Finance')) throw new Error('billing needs the synthetic Finance identity');
  return billing;
}

export function billingBasesMatch(bases, expectedIds, exported = false) {
  if (!Array.isArray(bases) || bases.length !== expectedIds.length) return false;
  const actual = bases.map((b) => b.organization?.id);
  return new Set(actual).size === expectedIds.length && expectedIds.every((id) => actual.includes(id)) &&
    (!exported || bases.every((b) => b.status === 'Exported' && typeof b.orderNo === 'string' && b.orderNo.length > 0 && b.exportedAt));
}
