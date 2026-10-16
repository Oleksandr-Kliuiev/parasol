import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { cursorExpiry, cursorKeyFromEnv, digestOf, injectedCursorKey, issueCursor, requireCursorKey, verifyCursor, CURSOR_MAX_LIFETIME_MS } from '../packages/correlation/cursor.ts';
import { assessCoverage } from '../packages/correlation/coverage.ts';
import type { RootState } from '../packages/correlation/coverage.ts';
import { assertInterval, assertUnexpired, eligibilityTransition } from '../packages/correlation/read.ts';
import { millisecondInstant, parseCorrelationInput, parseDirectoryListInput, parseSignInListInput } from '../packages/correlation/parameters.ts';
import { resolve } from '../packages/correlation/resolve.ts';
import type { MappingFacts, SourceFacts } from '../packages/correlation/resolve.ts';
import { floorMs, keyOfCanonical, keyOfDate, keyPlusMs, parseTimeInput } from '../packages/correlation/time.ts';

// S2-C pure rules without a database: the fixed-width seven-digit time key, strict read input, the authenticated cursor
// (fail-closed configuration, MAC before decoding, bounded size), traversal coverage vs freshness, and the resolver table —
// including SOURCE_DEVICE_MAPPING_AMBIGUOUS, which the one-confirmed-link-per-agent index makes unreachable in PostgreSQL.
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const SECRET = 'unit-test-synthetic-cursor-secret-0123456789';
const key = () => injectedCursorKey(SECRET);

test('time key: strict UTC input with 0..7 fractional digits, padded (never truncated) to one fixed width; lexical = chronological', () => {
  assert.equal(parseTimeInput('2026-10-08T10:00:00Z'), '2026-10-08T10:00:00.0000000Z');
  assert.equal(parseTimeInput('2026-10-08T10:00:00.5Z'), '2026-10-08T10:00:00.5000000Z');
  assert.equal(parseTimeInput('2026-10-08T10:00:00.1234567Z'), '2026-10-08T10:00:00.1234567Z');
  for (const bad of ['2026-10-08T10:00:00.12345678Z', '2026-10-08T10:00:00+00:00', '2026-10-08T10:00:00', '2026-02-30T00:00:00Z', '2026-10-08T24:00:00Z',
    '0999-01-01T00:00:00Z', ' 2026-10-08T10:00:00Z', 7, null]) assert.equal(parseTimeInput(bad), null, String(bad));
  assert.equal(keyOfCanonical('2026-10-08T10:00:00.005Z'), '2026-10-08T10:00:00.0050000Z');
  assert.equal(keyOfDate(new Date('2026-10-08T10:00:00.123Z')), '2026-10-08T10:00:00.1230000Z');
  assert.ok(parseTimeInput('2026-10-08T10:00:00.0050001Z')! > parseTimeInput('2026-10-08T10:00:00.005Z')!);
  assert.ok(parseTimeInput('2026-10-08T10:00:00.5Z')! > parseTimeInput('2026-10-08T10:00:00.49999Z')!, 'variable-width text alone would compare wrongly');
  assert.equal(keyPlusMs('2026-10-08T10:00:00.0050001Z', 86_400_000), '2026-10-09T10:00:00.0050001Z');
  assert.equal(floorMs('2026-10-08T10:00:00.0059999Z'), Date.parse('2026-10-08T10:00:00.005Z'));
  assert.equal(millisecondInstant('2026-10-08T10:00:00.1230000Z', 'from').toISOString(), '2026-10-08T10:00:00.123Z');
  assert.throws(() => millisecondInstant('2026-10-08T10:00:00.1230001Z', 'from'), fails('INVALID_READ_PARAMETERS'), 'sub-ms sync bounds are refused, never truncated');
});

test('read input: declared scalar keys only, IDs, from < to ≤ 24h, limit 1..100, shared cursor syntax', () => {
  const ok = { connectionId: 'c-1', observationId: 'o-1', from: '2026-10-08T00:00:00Z', to: '2026-10-09T00:00:00Z' };
  assert.deepEqual(parseCorrelationInput(ok), { connectionId: 'c-1', observationId: 'o-1', from: '2026-10-08T00:00:00.0000000Z', to: '2026-10-09T00:00:00.0000000Z',
    limit: 50, cursor: null });
  assert.equal(parseCorrelationInput({ ...ok, limit: '7' }).limit, 7);
  for (const bad of [{ ...ok, to: '2026-10-09T00:00:00.0000001Z' }, { ...ok, to: ok.from }, { ...ok, extra: 1 }, { ...ok, connectionId: ['c-1'] }, { ...ok, limit: 0 },
    { ...ok, limit: 1.5 }, { ...ok, limit: '01' }, { ...ok, observationId: 'bad id' }, Object.assign(Object.create({ inherited: 1 }), ok), [ok], 'x']) {
    assert.throws(() => parseCorrelationInput(bad), fails('INVALID_READ_PARAMETERS'));
  }
  for (const cursor of ['', 'x'.repeat(513), `${'A'.repeat(469)}.${'B'.repeat(43)}`, 'a.b', 7]) {
    assert.throws(() => parseCorrelationInput({ ...ok, cursor }), fails('CORRELATION_CURSOR_INVALID'));
  }
  assert.equal(parseCorrelationInput({ ...ok, cursor: `${'A'.repeat(468)}.${'B'.repeat(43)}` }).cursor!.length, 512);
  assert.throws(() => parseSignInListInput(ok), fails('INVALID_READ_PARAMETERS'), 'observationId is not a sign-in list parameter');
  assert.throws(() => parseDirectoryListInput({ connectionId: 'c', resourceType: 'm365_signin' }), fails('INVALID_READ_PARAMETERS'));
});

test('cursor: one shared configured key (≥32 bytes) or fail closed; MAC verified timing-safe before strict decoding; bounded size', () => {
  for (const env of [{}, { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'NAME' }, { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://MISSING' },
    { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://SHORT', SHORT: 'x'.repeat(31) }, { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'vault://x' }]) {
    assert.throws(() => cursorKeyFromEnv(env), fails('CORRELATION_CURSOR_CONFIG_INVALID'));
  }
  assert.throws(() => requireCursorKey(undefined), fails('CORRELATION_CURSOR_CONFIG_INVALID'));
  assert.throws(() => requireCursorKey(() => ({ mac: () => Buffer.alloc(32) })), fails('CORRELATION_CURSOR_CONFIG_INVALID'), 'only a key handle of this module');
  const env = { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://K', K: SECRET };
  const claims = { b: digestOf({ a: 1 }), f: digestOf({ f: 1 }), p: 'evidence-1', e: Date.now() + 1000 };
  const cursor = issueCursor(cursorKeyFromEnv(env), claims);
  assert.deepEqual(verifyCursor(key(), cursor), { v: 1, ...claims }, 'every process with the shared secret verifies the same cursor');
  assert.throws(() => verifyCursor(injectedCursorKey(`${SECRET}-other`), cursor), fails('CORRELATION_CURSOR_INVALID'));
  const [body, mac] = cursor.split('.') as [string, string];
  const forged = Buffer.from(JSON.stringify({ v: 1, ...claims, e: claims.e + 3_600_000 })).toString('base64url');
  assert.throws(() => verifyCursor(key(), `${forged}.${mac}`), fails('CORRELATION_CURSOR_INVALID'), 'a client-chosen expiry is never trusted');
  assert.throws(() => verifyCursor(key(), `${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`), fails('CORRELATION_CURSOR_INVALID'));
  const longest = issueCursor(key(), { ...claims, p: `p${'x'.repeat(127)}`, e: 8_640_000_000_000_000 });
  assert.ok(longest.length <= 512, `maximal claims fit the shared bound (${longest.length})`);
  assert.throws(() => issueCursor(key(), { ...claims, p: 'x'.repeat(129) }), fails('CORRELATION_CURSOR_INVALID'));
  const at = (k: string) => ({ now: new Date(floorMs(k)), key: k });
  const c = at('2026-10-08T12:00:00.1235000Z'); const ms = (iso: string) => Date.parse(iso);
  assert.equal(cursorExpiry(c, []), ms('2026-10-08T12:15:00.123Z'));
  assert.equal(cursorExpiry(c, [{ at: '2026-10-08T12:00:00.0000000Z' }, { at: '2026-10-08T12:00:05.0000000Z' }, { at: '2026-10-08T12:00:02.0000000Z' }]),
    ms('2026-10-08T12:00:02.000Z'), 'only FUTURE transitions shorten it');
  assert.throws(() => cursorExpiry(c, [{ at: '2026-10-08T12:00:02Z' }]), fails('CORRELATION_TRANSITION_INVALID'));
});

test('R1: future-ness is decided on seven-digit keys before flooring; a cursor may expire early but never outlives a transition', () => {
  const clock = (k: string) => ({ now: new Date(floorMs(k)), key: k });
  const first = clock('2026-10-08T12:00:00.1235000Z');
  const input = { from: '2026-10-01T12:00:00.1239000Z', to: '2026-10-02T12:00:00.0000000Z' };
  // The eligibility transition (from + 7d) lies later inside the clock's current millisecond: still future, so it bounds the cursor.
  const e = cursorExpiry(first, [eligibilityTransition(input)]);
  assert.equal(e, Date.parse('2026-10-08T12:00:00.123Z'), 'floored: conservatively expired at issue instead of a 15-minute cursor');
  const claims = { v: 1, b: digestOf(1), f: digestOf(2), p: 'p-1', e };
  assertInterval(input, first);
  const next = clock('2026-10-08T12:00:00.1240000Z');
  assert.throws(() => assertUnexpired(claims, next), fails('CORRELATION_CURSOR_EXPIRED'), 'the next page expires before interval validation');
  assert.throws(() => assertInterval(input, next), fails('CORRELATION_INTERVAL_NOT_RETAINED'), 'which a fresh first page would hit');
  // Boundary semantics: strict transitions (eligibility) change AFTER their instant, inclusive ones (expiry, freshness) AT it.
  assert.equal(cursorExpiry(first, [{ at: first.key, strict: true }]), Date.parse('2026-10-08T12:00:00.123Z'), 'strict at now: still future');
  assert.equal(cursorExpiry(first, [{ at: first.key }]), Date.parse('2026-10-08T12:15:00.123Z'), 'inclusive at now: already happened');
  assert.equal(cursorExpiry(first, [{ at: '2026-10-08T12:00:00.1234999Z' }, { at: '2026-10-08T12:00:00.1234999Z', strict: true }]),
    Date.parse('2026-10-08T12:15:00.123Z'), 'already-stale transitions never make data unpageable');
  assert.equal(cursorExpiry(first, [{ at: '2026-10-08T12:00:00.1235001Z' }]), Date.parse('2026-10-08T12:00:00.123Z'), 'sub-ms future inclusive transition');
  for (const k of ['2026-10-08T12:00:00.1235001Z', '2026-10-08T12:00:00.9999999Z', '2026-10-08T12:00:07.0000001Z']) {
    const bound = cursorExpiry(first, [{ at: k }]);
    assert.ok(bound <= floorMs(k), `never later than the transition ${k}`);
    assert.throws(() => assertUnexpired({ ...claims, e: bound }, clock(k)), fails('CORRELATION_CURSOR_EXPIRED'));
  }
});

const t = (iso: string) => new Date(iso);
const clock = (iso: string) => ({ now: t(iso), key: keyOfDate(t(iso)) });
const root = (from: string, published: string | null, extra: Partial<RootState> = {}): RootState => ({ windowId: `w-${from}`, rootFrom: t(from), started: 1, published: published ? 1 : 0,
  recorded: 1, status: published ? 'OK' : 'ERROR', safeErrorCode: published ? null : 'SYNC_LIMIT_EXCEEDED', latestState: published ? 'COMPLETE' : 'FAILED',
  attempt: published ? { id: `a-${from}`, state: 'COMPLETE', coveredFrom: t(from), coveredTo: new Date(t(from).getTime() + 3_600_000), publishedAt: t(published),
    expiresAt: t('2026-10-20T00:00:00Z') } : null, ...extra });

test('coverage: traversal status, real gaps and independent freshness; unavailable capability is never complete-empty', () => {
  const now = clock('2026-10-08T12:00:00Z');
  const complete = assessCoverage([root('2026-10-08T08:00:00Z', '2026-10-08T09:30:00Z')], null, keyOfDate(t('2026-10-08T08:00:00Z')), keyOfDate(t('2026-10-08T09:00:00Z')), now);
  assert.deepEqual([complete.coverage.status, complete.coverage.traversalComplete, complete.coverage.gaps, complete.coverage.freshness, complete.resource.status],
    ['COMPLETE', true, [], 'STALE', 'STALE'], 'historical full traversal: COMPLETE + STALE');
  const mixed = assessCoverage([root('2026-10-08T10:00:00Z', '2026-10-08T11:50:00Z'), root('2026-10-08T11:00:00Z', '2026-10-08T11:00:00Z')], null,
    keyOfDate(t('2026-10-08T10:30:00Z')), keyOfDate(t('2026-10-08T11:30:00Z')), now);
  assert.deepEqual([mixed.coverage.status, mixed.coverage.freshness, mixed.coverage.completedWindows.map(w => w.freshness)], ['COMPLETE', 'MIXED', ['FRESH', 'STALE']]);
  assert.ok(mixed.transitions.some(x => x.at === keyOfDate(t('2026-10-08T12:05:00Z')) && !x.strict), 'future freshness transition reported (inclusive)');
  assert.ok(mixed.transitions.some(x => x.strict), 'the retention clip transition is strict');
  const partial = assessCoverage([root('2026-10-08T10:00:00Z', '2026-10-08T11:55:00Z'), root('2026-10-08T11:00:00Z', null)], null,
    keyOfDate(t('2026-10-08T10:00:00Z')), keyOfDate(t('2026-10-08T12:00:00Z')), now);
  assert.deepEqual([partial.coverage.status, partial.coverage.gaps.map(g => g.reasonCode), partial.resource.status], ['PARTIAL', ['SYNC_LIMIT_EXCEEDED'], 'OK']);
  const pending = assessCoverage([root('2026-10-08T10:00:00Z', '2026-10-08T11:59:00Z', { started: 2 })], null, keyOfDate(t('2026-10-08T10:00:00Z')),
    keyOfDate(t('2026-10-08T11:00:00Z')), now);
  assert.equal(pending.coverage.freshness, 'STALE', 'a newer pending/failed refresh makes the retained portion STALE');
  const none = assessCoverage([], null, keyOfDate(t('2026-10-08T10:00:00Z')), keyOfDate(t('2026-10-08T11:00:00Z')), now);
  assert.deepEqual([none.coverage.status, none.coverage.freshness, none.resource.status, none.published], ['UNAVAILABLE', 'UNKNOWN', 'MISSING', []]);
  const capability = assessCoverage([root('2026-10-08T10:00:00Z', '2026-10-08T11:55:00Z')], { status: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE' },
    keyOfDate(t('2026-10-08T10:00:00Z')), keyOfDate(t('2026-10-08T11:00:00Z')), now);
  assert.deepEqual([capability.coverage.status, capability.resource.status, capability.resource.safeErrorCode, capability.published],
    ['UNAVAILABLE', 'MISSING', 'M365_SIGNINS_NOT_AVAILABLE', []]);
  const expired = assessCoverage([root('2026-10-08T10:00:00Z', '2026-10-08T11:55:00Z', { attempt: { ...root('2026-10-08T10:00:00Z', '2026-10-08T11:55:00Z').attempt!,
    expiresAt: t('2026-10-08T12:00:00Z') } })], null, keyOfDate(t('2026-10-08T10:00:00Z')), keyOfDate(t('2026-10-08T11:00:00Z')), now);
  assert.deepEqual([expired.coverage.status, expired.coverage.gaps.map(g => g.reasonCode)], ['UNAVAILABLE', ['RETENTION_EXPIRED']], 'query-time expiry');
});

const source = (over: Partial<SourceFacts> = {}): SourceFacts => ({ observationId: 'o', source: { eventKey: 'k', severity: 'CRITICAL', priority: 'URGENT', route: 'HUMAN_REVIEW' },
  sourceConnection: { id: 'h', status: 'ACTIVE', lifecycleVersion: 1 }, reference: { kind: 'AGENT', externalId: 'a' }, agentEntityId: 'x',
  sourceLinks: [{ id: 'l-h', status: 'CONFIRMED', entityId: 'd', externalEntityId: 'x', externalId: 'a' }], device: { id: 'd', personId: 'p' }, ...over });
const fresh = (resourceType: 'm365_user' | 'm365_device') => ({ resourceType, status: 'OK', safeErrorCode: null, activeGenerationId: `g-${resourceType}`, started: 1, published: 1,
  recorded: 1, lastSuccessAt: t('2026-10-08T11:59:00Z'), latestState: 'PUBLISHED', generation: { id: `g-${resourceType}`, completedAt: t('2026-10-08T11:59:00Z'),
    expiresAt: t('2026-10-09T11:59:00Z') } });
const mapping = (over: Partial<MappingFacts> = {}): MappingFacts => ({ deviceLinks: [{ id: 'l-d', status: 'CONFIRMED', entityId: 'd', externalEntityId: 'xd', externalId: 'od' }],
  personLinks: [{ id: 'l-u', status: 'CONFIRMED', entityId: 'p', externalEntityId: 'xu', externalId: 'ou' }],
  directory: { m365_user: fresh('m365_user'), m365_device: fresh('m365_device') }, deviceObject: { deviceId: 'reg', duplicates: 1 }, userObject: { sourceObjectId: 'ou' }, ...over });

test('resolver table: independent device/person paths, fixed vocabulary, sorted codes; ambiguous source mapping fails closed', () => {
  const now = clock('2026-10-08T12:00:00Z');
  const r = (s: Partial<SourceFacts>, m: Partial<MappingFacts> = {}) => { const x = resolve(source(s), mapping(m), now); return [x.device, x.person, x.reasonCodes, x.deviceRef, x.userRef]; };
  assert.deepEqual(r({}), ['RESOLVED', 'RESOLVED', [], 'reg', 'ou']);
  assert.deepEqual(r({ sourceLinks: [source().sourceLinks[0]!, { ...source().sourceLinks[0]!, id: 'l-h2' }] }), ['AMBIGUOUS', 'AMBIGUOUS', ['SOURCE_DEVICE_MAPPING_AMBIGUOUS'], null, null]);
  assert.deepEqual(r({ reference: { kind: 'MISSING' }, sourceConnection: { id: 'h', status: 'DISABLED', lifecycleVersion: 2 } }),
    ['UNRESOLVED', 'UNRESOLVED', ['SOURCE_CONNECTION_DISABLED', 'SOURCE_DEVICE_REFERENCE_MISSING'], null, null]);
  assert.deepEqual(r({}, { deviceLinks: [] }), ['UNRESOLVED', 'RESOLVED', ['M365_DEVICE_MAPPING_MISSING'], null, 'ou'], 'route (b) without route (a)');
  assert.deepEqual(r({}, { deviceObject: { deviceId: 'reg', duplicates: 2 } }), ['AMBIGUOUS', 'RESOLVED', ['M365_DEVICE_REFERENCE_AMBIGUOUS'], null, 'ou']);
  assert.deepEqual(r({ device: { id: 'd', personId: null } }), ['RESOLVED', 'UNRESOLVED', ['ASSIGNED_PERSON_MISSING'], 'reg', null]);
  assert.deepEqual(r({}, { directory: { m365_user: null, m365_device: fresh('m365_device') } }), ['RESOLVED', 'UNRESOLVED', ['DIRECTORY_MISSING'], 'reg', null]);
  const aged = { ...fresh('m365_device'), generation: { id: 'g', completedAt: t('2026-10-08T10:00:00Z'), expiresAt: t('2026-10-09T10:00:00Z') } };
  assert.deepEqual(r({}, { directory: { m365_user: fresh('m365_user'), m365_device: aged } }), ['RESOLVED', 'RESOLVED', ['DIRECTORY_STALE'], 'reg', 'ou']);
  const expired = { ...aged, generation: { ...aged.generation, expiresAt: t('2026-10-08T12:00:00Z') } };
  assert.deepEqual(r({}, { directory: { m365_user: fresh('m365_user'), m365_device: expired } }), ['UNRESOLVED', 'RESOLVED', ['DIRECTORY_EXPIRED'], null, 'ou']);
});
