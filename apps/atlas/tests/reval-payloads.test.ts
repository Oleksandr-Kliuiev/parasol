import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterRequest, closureAfterReread, executorTimeout, pauseDeadlines, refusedCodeFor, remainingForExecutor } from '../packages/reval/closure.ts';
import { decodeOwnerConfig, loadOwnerConfig } from '../packages/reval/config.ts';
import { CensusRelationError, decodeClosure, decodeIdentity, decodeSnapshot, pricingMatches } from '../packages/reval/payloads.ts';
import type { SnapshotWrapper } from '../packages/reval/payloads.ts';
import { decodePeerFacts } from '../packages/reval/peer.ts';
import { exportSnapshot, readerCodeFor, ReaderFailure, wrapperBound } from '../packages/reval/snapshot-reader.ts';
import { readSecretFile, SecretFileError } from '../packages/reval/secret-file.ts';
import { RevalShapeError } from '../packages/reval/scalars.ts';
import { ASK_REMOTE_PROFILE } from '../packages/ask/remote/budget.ts';

// R-EVAL RS-A payloads and decisions (brief §4/§6/§7, ACCEPTANCE_CHECKS.md unit list): exact 01/02 payloads and census
// relationships, the four-key closure, every row of the phase/outcome map, budgets, approved pricing, owner config and
// closed secret files. Pure (files only in a realpath temp dir).
const adm = randomUUID();
const attempt = (over: Record<string, unknown> = {}) => ({ attemptId: randomUUID(), correlationId: randomUUID(), admissionId: adm, policyVersion: '3',
  createdAt: '2026-10-11T23:59:59.999Z', dayStart: '2026-10-11', monthStart: '2026-10-01', reservedMicroUsd: '300000', accountedMicroUsd: '0',
  state: 'SETTLED', outcome: 'NO_DISPATCH', settledAt: '2026-10-12T00:00:00.001Z', ...over });
const snapshot = (over: Record<string, unknown> = {}) => ({ snapshotId: randomUUID(), dbObservedAt: '2026-10-12T00:00:01.000Z', admissionId: adm,
  policyVersion: '3', fenceEpoch: '4', policyState: 'ACTIVE', reserveMicroUsd: '300000', dayCapMicroUsd: '2000000', monthCapMicroUsd: '10000000',
  expiresAt: '2026-10-13T00:00:00.000Z', currentDay: '2026-10-12', currentMonth: '2026-10-01', fixtureGeneration: '1', fixtureId: 'FX01',
  projectAttemptCount: '1', foreignScopeAttemptCount: '0',
  periods: [{ kind: 'MONTH', periodStart: '2026-10-01', chargedMicroUsd: '0', attemptCount: '1' }, { kind: 'DAY', periodStart: '2026-10-11', chargedMicroUsd: '0', attemptCount: '1' },
    { kind: 'DAY', periodStart: '2026-10-12', chargedMicroUsd: '0', attemptCount: '0' }],
  attempts: [attempt()], consistent: true, ...over });

test('SNAPSHOT: exact keys and every census relationship; ms truncation keeps the original UTC day; consistent:false is schema-only', () => {
  assert.doesNotThrow(() => decodeSnapshot(snapshot()));
  assert.throws(() => decodeSnapshot({ ...snapshot(), extra: 1 }), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ fenceEpoch: 4 })), RevalShapeError, 'JSON number');
  assert.throws(() => decodeSnapshot(snapshot({ consistent: 'true' })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ reserveMicroUsd: '300001' })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ dayCapMicroUsd: '2000001' })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ currentDay: '2026-10-11' })), RevalShapeError, 'currentDay = UTC day of dbObservedAt');
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ dayStart: '2026-10-12' })] })), RevalShapeError, 'dayStart = UTC(createdAt)');
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ admissionId: randomUUID() })] })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ policyVersion: '4' })] })), RevalShapeError, 'attempt version ≤ current');
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ outcome: 'USAGE_VERIFIED', accountedMicroUsd: '300001' })] })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ state: 'UNKNOWN', outcome: 'DELIVERY_UNKNOWN', accountedMicroUsd: '0' })] })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ attempts: [attempt({ state: 'EGRESS_COMMITTED' })] })), RevalShapeError);
  assert.throws(() => decodeSnapshot(snapshot({ periods: snapshot().periods.slice().reverse() })), RevalShapeError, 'MONTH then DAY by date');
  assert.throws(() => decodeSnapshot(snapshot({ periods: snapshot().periods.slice(0, 2) })), RevalShapeError, 'current DAY present');
  assert.throws(() => decodeSnapshot(snapshot({ projectAttemptCount: '2' })), CensusRelationError, 'project = attempts + foreign');
  assert.throws(() => decodeSnapshot(snapshot({ periods: [{ kind: 'MONTH', periodStart: '2026-10-01', chargedMicroUsd: '1', attemptCount: '1' },
    ...snapshot().periods.slice(1)] })), CensusRelationError, 'ΣDAY.charged = MONTH.charged and registered accounted = charged when foreign = 0');
  // Inconsistent census: exported schema-validated only (no relationship check, no headroom meaning).
  assert.doesNotThrow(() => decodeSnapshot(snapshot({ projectAttemptCount: '2', consistent: false })));
  const two = [attempt({ attemptId: 'ffffffff-ffff-4fff-bfff-ffffffffffff' }), attempt({ attemptId: '00000000-0000-4000-8000-000000000000' })];
  assert.throws(() => decodeSnapshot(snapshot({ attempts: two, projectAttemptCount: '2', consistent: false })), RevalShapeError, 'ordered (createdAt, id)');
});

test('IDENTITY and the four-key CLOSURE are exact', () => {
  const id = { databaseInstanceId: randomUUID(), buildManifestSha256: 'a'.repeat(64), runtimeImageSha256: 'b'.repeat(64), launcherManifestSha256: 'c'.repeat(64),
    platformEvidenceRef: 'rsa-peertoken-unixphys-v1', loadedBinding: 'UNVERIFIED', startedAt: '2026-10-11T00:00:00.000Z' };
  assert.doesNotThrow(() => decodeIdentity(id));
  assert.throws(() => decodeIdentity({ ...id, loadedBinding: 'VERIFIED' }), RevalShapeError);
  assert.throws(() => decodeIdentity({ ...id, platformEvidenceRef: 'https://x' }), RevalShapeError);
  const c = { admissionId: adm, paused: true, policyVersion: '4', fenceEpoch: '5' };
  assert.doesNotThrow(() => decodeClosure(c));
  assert.throws(() => decodeClosure({ ...c, paused: 'true' }), RevalShapeError, 'string "true"');
  assert.throws(() => decodeClosure({ ...c, paused: 1 }), RevalShapeError);
  assert.throws(() => decodeClosure({ ...c, at: 'x' }), RevalShapeError, 'extra key');
  const { fenceEpoch, ...missing } = c; void fenceEpoch;
  assert.throws(() => decodeClosure(missing), RevalShapeError, 'missing key');
  assert.throws(() => decodeClosure({ ...c, policyVersion: '0' }), RevalShapeError);
});

test('phase/outcome map: before the request no latch; after it anything but a valid result latches; reread exact + strict floors', () => {
  const ch = randomUUID();
  const ok = { contractVersion: 'RevalOwnerExecResultV1' as const, challenge: ch, outcome: 'CONFIRMED_COMMIT' as const, revisionApplied: false, policyVersion: '4', fenceEpoch: '5', code: null };
  assert.deepEqual(afterRequest(null, ch), { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'malformed/missing/EOF/exit/kill');
  assert.deepEqual(afterRequest({ ...ok, challenge: randomUUID() }, ch), { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'wrong challenge');
  assert.deepEqual(afterRequest({ ...ok, outcome: 'COMMIT_UNKNOWN', revisionApplied: null, policyVersion: null, fenceEpoch: null }, ch),
    { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true });
  for (const [state, code] of [['AR004', 'REGISTRATION_MISMATCH'], ['AR009', 'POLICY_CHANGED'], ['AR008', 'CONTAINMENT_UNCONFIRMED'], ['22003', 'CONTAINMENT_UNCONFIRMED'],
    ['42501', 'OWNER_REQUIRED'], ['28P01', 'OWNER_REQUIRED'], ['28000', 'OWNER_REQUIRED'], ['55P03', 'DEADLINE'], ['57014', 'DEADLINE'], ['XX000', 'INTERNAL_FAILURE'], [undefined, 'INTERNAL_FAILURE']] as const) {
    assert.equal(refusedCodeFor(state), code, String(state));
    assert.deepEqual(afterRequest({ ...ok, outcome: 'REFUSED', revisionApplied: null, policyVersion: null, fenceEpoch: null, code }, ch), { kind: 'FAILURE', code, latch: false });
  }
  assert.deepEqual(afterRequest({ ...ok, outcome: 'REFUSED', revisionApplied: null, policyVersion: null, fenceEpoch: null, code: 'UNAUTHORIZED' }, ch),
    { kind: 'FAILURE', code: 'UNAUTHORIZED', latch: false }, 'invalid secret file');
  const committed = { policyVersion: '4', fenceEpoch: '5' };
  const rr = { admissionId: adm, policyState: 'PAUSED', policyVersion: '4', fenceEpoch: '5' };
  const floors = { policyFloor: '3', fenceFloor: '4' };
  assert.deepEqual(closureAfterReread(adm, committed, rr, floors), { kind: 'CLOSURE', closure: { admissionId: adm, paused: true, policyVersion: '4', fenceEpoch: '5' } });
  const latched = { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true };
  assert.deepEqual(closureAfterReread(adm, committed, null, floors), latched, 'reread failure after a confirmed commit');
  for (const drift of [{ policyVersion: '5' }, { fenceEpoch: '6' }, { policyState: 'ACTIVE' }, { admissionId: randomUUID() }]) {
    assert.deepEqual(closureAfterReread(adm, committed, { ...rr, ...drift }, floors), latched, JSON.stringify(drift));
  }
  assert.deepEqual(closureAfterReread(adm, committed, rr, { policyFloor: '4', fenceFloor: '4' }), latched, 'equal floor is not strictly above');
  assert.deepEqual(closureAfterReread(adm, committed, rr, { policyFloor: '3', fenceFloor: '5' }), latched, 'stale already-PAUSED tuple');
  assert.deepEqual(closureAfterReread(adm, { policyVersion: '9223372036854775807', fenceEpoch: '5' }, { ...rr, policyVersion: '9223372036854775807' },
    { policyFloor: '9223372036854775806', fenceFloor: '4' }).kind, 'CLOSURE', 'BigInt boundary');
});

test('budget: one 1800 ms deadline, derived sub-deadlines, relative clamped executor time, server timeouts never exceed the rest', () => {
  const d = pauseDeadlines(1000);
  assert.deepEqual(d, { D: 2800, requestBy: 1600, DE: 2400, rereadBy: 2750 });
  assert.equal(remainingForExecutor(d.DE, 1000), 1400, 'clamped to 1400');
  assert.equal(remainingForExecutor(d.DE, 2000), 400);
  assert.equal(remainingForExecutor(d.DE, 2400), null, 'nothing left: never a fresh budget');
  assert.equal(executorTimeout(5000, 0), 1400);
  assert.equal(executorTimeout(100, 99), 1);
  for (let now = 0; now < 2000; now += 37) assert.ok(executorTimeout(1400, now) <= Math.max(1, 1400 - now), String(now));
});

const wrapper = (policy: Partial<SnapshotWrapper['pricing']['policy']> = {}, attempts: object[] = []) => ({
  registrationId: randomUUID(), databaseInstanceId: randomUUID(), buildManifestSha256: 'a'.repeat(64), systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3',
  pricing: { policy: { profile: ASK_REMOTE_PROFILE, priceRevision: 'price-a', reserveMicroUsd: '300000', ...policy }, attempts },
  snapshot: (({ snapshotId, ...rest }) => { void snapshotId; return rest; })(snapshot()) }) as unknown as SnapshotWrapper;
const tuple = (over: object = {}) => ({ profile: ASK_REMOTE_PROFILE, priceRevision: 'price-a', reservedMicroUsd: '300000', promptRate: '275', completionRate: '825', ...over });
test('approved pricing: policy AND every project attempt against the accepted constants and owner expectation; never exported', () => {
  assert.ok(pricingMatches(wrapper(), 'price-a'), 'no attempts');
  assert.ok(pricingMatches(wrapper({}, [tuple()]), 'price-a'));
  assert.ok(!pricingMatches(wrapper({ priceRevision: 'price-b' }), 'price-a'), 'policy ≠ approved (not a policy-to-itself check)');
  assert.ok(!pricingMatches(wrapper({}, [tuple({ priceRevision: 'price-old' })]), 'price-a'), 'historical attempt price');
  assert.ok(!pricingMatches(wrapper({}, [tuple(), tuple({ priceRevision: 'price-old' })]), 'price-a'), 'mixed tuples');
  assert.ok(!pricingMatches(wrapper({}, [tuple({ promptRate: '276' })]), 'price-a'));
  assert.ok(!pricingMatches(wrapper({ profile: 'other-profile' }), 'price-a'));
  assert.throws(() => exportSnapshot(wrapper({ priceRevision: 'price-b' }), 'price-a'), (e: ReaderFailure) => e.code === 'POLICY_CHANGED');
  const exported = exportSnapshot(wrapper({}, [tuple()]), 'price-a');
  // Inspect fields/values, not substrings: a random snapshot UUID can legitimately contain 275 or 825.
  const privateFields = new Set(['pricing', 'priceRevision', 'promptRate', 'completionRate', 'systemIdentifier', 'registrationId']);
  const inspect = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { assert.ok(!privateFields.has(key), key); inspect(child); }
    } else assert.ok(!['price-a', '275', '825', 275, 825].includes(value as string | number), 'private pricing value');
  };
  inspect(exported);
  for (const [s, code] of [['RV001', 'REGISTRATION_MISMATCH'], ['RV002', 'CENSUS_UNAVAILABLE'], ['RV003', 'CENSUS_LIMIT_EXCEEDED'], ['RV004', 'POLICY_CHANGED'],
    ['RV005', 'FIXTURE_MISMATCH'], ['RV006', 'CENSUS_UNAVAILABLE'], ['57014', 'CENSUS_UNAVAILABLE'], ['55P03', 'CENSUS_UNAVAILABLE'], ['XX000', 'INTERNAL_FAILURE']] as const) {
    assert.equal(readerCodeFor(s), code, s);
  }
});

test('wrapper binding: the snapshot start epoch must EQUAL the recorded tuple (−1 s or +1 s alone refuses); every other bound fact too', () => {
  const w = wrapper(); const exp = { registrationId: w.registrationId, databaseInstanceId: w.databaseInstanceId, buildManifestSha256: w.buildManifestSha256,
    physical: { systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3', postmasterPid: '42', dataDirectory: '/data', socketDevice: '1', socketInode: '2' } };
  assert.ok(wrapperBound(w, exp), 'exact');
  for (const start of ['2', '4']) assert.ok(!wrapperBound(w, { ...exp, physical: { ...exp.physical, postmasterStartTime: start } }), `start ${start}`);
  assert.ok(!wrapperBound(w, { ...exp, physical: { ...exp.physical, databaseOid: '3' } }));
  assert.ok(!wrapperBound(w, { ...exp, buildManifestSha256: 'b'.repeat(64) }));
});

const physical = { systemIdentifier: '7', databaseOid: '16384', postmasterStartTime: '1700000000', postmasterPid: '42', dataDirectory: '/data', socketDevice: '1', socketInode: '2' };
const config = () => ({ contractVersion: 'RevalOwnerConfigV1', registrationId: randomUUID(), databaseInstanceId: randomUUID(), workspaceId: 'ws', clientId: 'c',
  actorId: 'a', admissionId: randomUUID(), approvedPriceRevision: 'price-a', nativePeerHelper: '/h/reval-peer', nativePeerHelperSha256: 'f'.repeat(64),
  endpoint: { socketDir: '/sock', port: 5432, database: 'atlas' }, roles: { reader: 'r', runtime: 'rt', owner: 'o' }, physical,
  secretFiles: { reader: '/s/r', runtime: '/s/rt', owner: '/s/o' }, server: { mode: 'LAUNCH', apiEntry: '/a/main.js', port: 3100 } });
test('owner config: closed; no host/TCP field; required approvedPriceRevision and helper pin; absolute paths; exact server modes', async () => {
  assert.doesNotThrow(() => decodeOwnerConfig(config()));
  for (const mutate of [(c: any) => { c.endpoint.host = '127.0.0.1'; }, (c: any) => { c.transport = 'TCP_LOOPBACK_TEST'; }, (c: any) => { delete c.approvedPriceRevision; },
    (c: any) => { delete c.nativePeerHelperSha256; }, (c: any) => { c.secretFiles.owner = 'rel/owner'; }, (c: any) => { c.server.mode = 'ATTACH'; },
    (c: any) => { c.roles.owner = c.roles.reader; }, (c: any) => { c.approvedPriceRevision = 'x'; }]) {
    const c = config(); mutate(c);
    assert.throws(() => decodeOwnerConfig(c), RevalShapeError);
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reval-cfg-')));
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'config.json'), JSON.stringify(config()), { mode: 0o600 });
  assert.equal((await loadOwnerConfig(join(dir, 'config.json'))).roles.reader, 'r');
  await chmod(join(dir, 'config.json'), 0o644);
  await assert.rejects(loadOwnerConfig(join(dir, 'config.json')), /OWNER_CONFIG_INVALID/, '0644');
  await chmod(join(dir, 'config.json'), 0o600); await chmod(dir, 0o755);
  await assert.rejects(loadOwnerConfig(join(dir, 'config.json')), /OWNER_CONFIG_INVALID/, 'directory not 0700');
  await chmod(dir, 0o700);
  await symlink(join(dir, 'config.json'), join(dir, 'link.json'));
  await assert.rejects(loadOwnerConfig(join(dir, 'link.json')), /OWNER_CONFIG_INVALID/, 'symlink');
  await writeFile(join(dir, 'dup.json'), '{"contractVersion":"RevalOwnerConfigV1","contractVersion":"RevalOwnerConfigV1"}', { mode: 0o600 });
  await assert.rejects(loadOwnerConfig(join(dir, 'dup.json')), /OWNER_CONFIG_INVALID/, 'duplicate key');
});

test('secret files: pure password only; symlink, 0644, FIFO, oversize, missing, URL/host/whitespace content refused; content never echoed', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reval-secret-')));
  const put = async (name: string, content: string, mode = 0o600) => { const p = join(dir, name); await writeFile(p, content, { mode }); await chmod(p, mode); return p; };
  assert.equal((await readSecretFile(await put('ok', 'Abcdefgh12345678._~-\n'))).toString(), 'Abcdefgh12345678._~-');
  const reason = (p: Promise<unknown>) => p.then(() => 'NONE', (e: SecretFileError) => e.reason);
  assert.equal(await reason(readSecretFile(await put('perm', 'Abcdefgh12345678', 0o644))), 'MODE');
  assert.equal(await reason(readSecretFile(join(dir, 'missing'))), 'PATH');
  assert.equal(await reason(readSecretFile(await put('short', 'abc'))), 'CONTENT');
  assert.equal(await reason(readSecretFile(await put('long', 'a'.repeat(300)))), 'SIZE');
  for (const [n, c] of [['url', 'postgresql://u:p@host/db'], ['host', 'host=127.0.0.1xxxxxx'], ['colon', 'abcdefghijklmn:op'], ['ws', 'abcdefgh ijklmnop'], ['two', 'abcdefghijklmnop\n\n']]) {
    const err = await readSecretFile(await put(n, c)).then(() => null, (e: Error) => e);
    assert.equal((err as SecretFileError).reason, 'CONTENT', n);
    assert.ok(!err!.message.includes(c), 'no echo');
  }
  await symlink(join(dir, 'ok'), join(dir, 'link'));
  assert.equal(await reason(readSecretFile(join(dir, 'link'))), 'PATH');
  execFileSync('/usr/bin/mkfifo', ['-m', '600', join(dir, 'fifo')]);
  assert.equal(await reason(readSecretFile(join(dir, 'fifo'))), 'TYPE');
  await mkdir(join(dir, 'sub'), { mode: 0o700 });
  assert.equal(await reason(readSecretFile(join(dir, 'sub'))), 'TYPE');
});

test('peer helper output: exactly one line with exactly eight keys (exeMatch required); integers and strict booleans', () => {
  const ok = { pid: 10, pidversion: 5, euid: 501, ppid: 1, startSec: 1, startUsec: 2, hasTty: false, exeMatch: true };
  assert.deepEqual(decodePeerFacts(`${JSON.stringify(ok)}\n`), ok);
  const { exeMatch, ...noExe } = ok; void exeMatch;
  for (const bad of [JSON.stringify(ok), `${JSON.stringify(ok)}\n\n`, `${JSON.stringify(noExe)}\n`, `${JSON.stringify({ ...ok, extra: 1 })}\n`,
    `${JSON.stringify({ ...ok, hasTty: 0 })}\n`, `${JSON.stringify({ ...ok, pid: '10' })}\n`, `${JSON.stringify({ ...ok, pid: 0 })}\n`, 'garbage\n']) {
    assert.throws(() => decodePeerFacts(bad), RevalShapeError, bad);
  }
});
