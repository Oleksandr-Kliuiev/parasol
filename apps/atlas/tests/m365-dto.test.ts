import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasError } from '../packages/core/contracts.ts';
import { requiredUtcTime, requiredOpaqueId, optionalGuid } from '../connectors/microsoft365/dto-common.ts';
import { parseM365User, parseM365Device, parseM365UserPage, parseM365DevicePage } from '../connectors/microsoft365/directory-dto.ts';
import { parseM365SignIn, parseM365SignInPage } from '../connectors/microsoft365/signin-dto.ts';
import type { CorrelationContextV1 } from '../packages/correlation/contracts.ts';
import * as atera from '../connectors/atera/contract.ts';
import { optionalTime } from '../connectors/dto.ts';

// Stage 2 task 2.1 without a database: Graph DTO projections, validators and the correlation response types.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NIL = '00000000-0000-0000-0000-000000000000';

function mismatch(fn: () => unknown, field: string, canary?: string): void {
  assert.throws(fn, (e: AtlasError) => {
    assert.equal(e.code, 'UPSTREAM_CONTRACT_MISMATCH');
    assert.equal(e.kind, 'PERMANENT');
    assert.deepEqual(e.details, { field });
    if (canary) assert.ok(!JSON.stringify(e).includes(canary) && !e.message.includes(canary), 'the error never carries the value');
    return true;
  });
}

test('user: exact allowlist projection drops every other Graph field', () => {
  const { dto, reasons } = parseM365User({ id: U1.toUpperCase(), displayName: 'Ola Nordmann', userPrincipalName: 'ola@example.test', userType: 'Member', accountEnabled: true,
    mail: 'mail-canary@example.test', mobilePhone: '+4799999999', '@odata.type': '#microsoft.graph.user', signInActivity: { lastSignInDateTime: 'x' } });
  assert.deepEqual(dto, { id: U1, displayName: 'Ola Nordmann', userPrincipalName: 'ola@example.test', userType: 'MEMBER', accountEnabled: true });
  assert.deepEqual(reasons, []);
  assert.deepEqual(Object.keys(dto), ['id', 'displayName', 'userPrincipalName', 'userType', 'accountEnabled']);
  assert.ok(!JSON.stringify(dto).includes('canary') && !JSON.stringify(dto).includes('4799999999'));
});

test('user: missing optional fields are null, never false/default; empty text is null', () => {
  assert.deepEqual(parseM365User({ id: U1 }).dto, { id: U1, displayName: null, userPrincipalName: null, userType: null, accountEnabled: null });
  assert.deepEqual(parseM365User({ id: U1, displayName: '   ', userPrincipalName: null, userType: null, accountEnabled: null }).dto,
    { id: U1, displayName: null, userPrincipalName: null, userType: null, accountEnabled: null });
});

test('user: unknown userType becomes UNKNOWN with a safe reason; the raw value is not copied', () => {
  const parsed = parseM365User({ id: U1, userType: 'Contoso-NewKind-canary' });
  assert.equal(parsed.dto.userType, 'UNKNOWN');
  assert.deepEqual(parsed.reasons, ['USER_TYPE_UNKNOWN']);
  assert.ok(!JSON.stringify(parsed).includes('canary'));
  assert.equal(parseM365User({ id: U1, userType: 'guest' }).dto.userType, 'GUEST');
  mismatch(() => parseM365User({ id: U1, userType: 7 }), 'user.userType');
});

test('user: invalid required id and wrong types fail without echoing the value', () => {
  for (const id of [undefined, null, '', 'not-a-guid-canary', 42, NIL, `${U1}x`, ` ${U1}`]) mismatch(() => parseM365User({ id }), 'user.id', 'canary');
  mismatch(() => parseM365User({ id: U1, accountEnabled: 'true' }), 'user.accountEnabled');
  mismatch(() => parseM365User({ id: U1, displayName: 5 }), 'user.displayName');
  mismatch(() => parseM365User(null), 'user');
  mismatch(() => parseM365User([]), 'user');
});

test('user: text is cleaned and bounded; oversized raw input fails', () => {
  const dto = parseM365User({ id: U1, displayName: `a\u0000b\n${'x'.repeat(400)}`, userPrincipalName: `${'u'.repeat(400)}@example.test` }).dto;
  assert.equal(dto.displayName?.length, 256);
  assert.ok(!/[\u0000-\u001f]/.test(dto.displayName!));
  assert.equal(dto.userPrincipalName?.length, 320);
  mismatch(() => parseM365User({ id: U1, displayName: 'y'.repeat(5000) }), 'user.displayName');
});

test('device: id and deviceId stay distinct; empty or nil deviceId is null; extras dropped', () => {
  const d = parseM365Device({ id: U1, deviceId: D1.toUpperCase(), displayName: 'GASTA-LT-07', accountEnabled: false, operatingSystem: 'Windows',
    registeredOwners: [{ id: U2 }], extensionAttributes: { extensionAttribute1: 'canary' }, trustType: 'AzureAd' });
  assert.deepEqual(d.dto, { id: U1, deviceId: D1, displayName: 'GASTA-LT-07', accountEnabled: false, operatingSystem: 'Windows' });
  assert.notEqual(d.dto.id, d.dto.deviceId);
  assert.ok(!JSON.stringify(d).includes('canary'));
  assert.equal(parseM365Device({ id: U1, deviceId: '' }).dto.deviceId, null);
  assert.equal(parseM365Device({ id: U1, deviceId: NIL }).dto.deviceId, null);
  assert.deepEqual(parseM365Device({ id: U1 }).dto, { id: U1, deviceId: null, displayName: null, accountEnabled: null, operatingSystem: null });
  mismatch(() => parseM365Device({ id: U1, deviceId: 'garbage-canary' }), 'device.deviceId', 'canary');
  mismatch(() => parseM365Device({ id: '' }), 'device.id');
  assert.equal(parseM365Device({ id: U1, operatingSystem: 'o'.repeat(300) }).dto.operatingSystem?.length, 128);
});

test('directory pages: one bad row, a duplicate id, a missing value or more than 500 rows fail the whole page', () => {
  const page = parseM365UserPage({ value: [{ id: U1, userType: 'Weird' }, { id: U2 }], '@odata.nextLink': 'https://attacker.example/next' });
  assert.deepEqual(page.items.map(i => i.id), [U1, U2]);
  assert.deepEqual(page.reasons, ['USER_TYPE_UNKNOWN']);
  assert.ok(!JSON.stringify(page).includes('attacker'), 'paging links are not part of the DTO page');
  assert.deepEqual(parseM365DevicePage({ value: [] }).items, []);
  mismatch(() => parseM365UserPage({ value: [{ id: U1 }, { id: 'bad' }] }), 'user.id');
  mismatch(() => parseM365UserPage({ value: [{ id: U1 }, { id: U1 }] }), 'value.id');
  mismatch(() => parseM365UserPage({}), 'value');
  mismatch(() => parseM365UserPage({ value: null }), 'value');
  mismatch(() => parseM365DevicePage({ value: Array.from({ length: 501 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` })) }), 'value');
  assert.equal(parseM365DevicePage({ value: Array.from({ length: 500 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` })) }).items.length, 500);
});

test('sign-in: projects the allowlist only; IP, location, UPN, auth details, risk, free text and tokens are stripped', () => {
  const raw = {
    id: 'opaque-signin-id_1', createdDateTime: '2026-10-07T07:15:30.1234567Z', userId: U1, userDisplayName: 'Name Canary', userPrincipalName: 'upn-canary@example.test',
    appId: U2, appDisplayName: 'App Canary', ipAddress: '203.0.113.99', location: { city: 'Oslo-canary', countryOrRegion: 'NO' },
    deviceDetail: { deviceId: D1, displayName: 'host-canary', operatingSystem: 'Win', browser: 'Edge' }, isInteractive: false,
    status: { errorCode: 50126, failureReason: 'Invalid username or password canary', additionalDetails: 'detail canary' },
    authenticationDetails: [{ authenticationMethod: 'Password' }], appliedConditionalAccessPolicies: [{ id: 'ca' }], riskLevelDuringSignIn: 'high',
    riskState: 'atRisk', accessToken: 'token-canary', '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
  };
  const dto = parseM365SignIn(raw);
  assert.deepEqual(dto, { id: 'opaque-signin-id_1', createdDateTime: '2026-10-07T07:15:30.1234567Z', userId: U1, deviceId: D1, appId: U2, errorCode: 50126, isInteractive: false });
  assert.deepEqual(Object.keys(dto), ['id', 'createdDateTime', 'userId', 'deviceId', 'appId', 'errorCode', 'isInteractive']);
  const text = JSON.stringify(dto);
  for (const canary of ['canary', '203.0.113', 'Oslo', 'Password', 'atRisk', 'graph.microsoft.com']) assert.ok(!text.includes(canary), canary);
  assert.equal(raw.ipAddress, '203.0.113.99', 'the input is not mutated');
});

test('sign-in: missing status, deviceDetail and booleans stay null, never success/false; empty and nil references are null', () => {
  const base = { id: 's1', createdDateTime: '2026-10-07T07:00:00Z' };
  assert.deepEqual(parseM365SignIn(base), { id: 's1', createdDateTime: '2026-10-07T07:00:00.000Z', userId: null, deviceId: null, appId: null, errorCode: null, isInteractive: null });
  assert.deepEqual(parseM365SignIn({ ...base, userId: '', appId: NIL, deviceDetail: { deviceId: '' }, status: { errorCode: null }, isInteractive: null }),
    { id: 's1', createdDateTime: '2026-10-07T07:00:00.000Z', userId: null, deviceId: null, appId: null, errorCode: null, isInteractive: null });
  assert.equal(parseM365SignIn({ ...base, deviceDetail: null, status: null }).errorCode, null);
  assert.equal(parseM365SignIn({ ...base, status: { errorCode: 0 } }).errorCode, 0);
  assert.equal(optionalGuid(undefined, 'x'), null);
});

test('sign-in: malformed required and optional fields fail safely', () => {
  const base = { id: 's1', createdDateTime: '2026-10-07T07:00:00Z' };
  for (const id of [undefined, null, '', 5, 'a'.repeat(257), 'bad\nid', 'lone\ud800']) mismatch(() => parseM365SignIn({ ...base, id }), 'signIn.id');
  assert.equal(parseM365SignIn({ ...base, id: 'a'.repeat(256) }).id.length, 256);
  mismatch(() => parseM365SignIn({ ...base, userId: 'not-guid-canary' }), 'signIn.userId', 'canary');
  mismatch(() => parseM365SignIn({ ...base, deviceDetail: 'x' }), 'signIn.deviceDetail');
  mismatch(() => parseM365SignIn({ ...base, deviceDetail: { deviceId: 12 } }), 'signIn.deviceDetail.deviceId');
  mismatch(() => parseM365SignIn({ ...base, status: 'x' }), 'signIn.status');
  for (const errorCode of ['50126', -1, 1.5, Number.NaN, 2 ** 60]) mismatch(() => parseM365SignIn({ ...base, status: { errorCode } }), 'signIn.status.errorCode');
  mismatch(() => parseM365SignIn({ ...base, isInteractive: 'false' }), 'signIn.isInteractive');
  mismatch(() => parseM365SignIn({ id: 's1' }), 'signIn.createdDateTime');
  mismatch(() => parseM365SignIn('row'), 'signIn');
});

test('sign-in page: any invalid row, missing value or more than 500 rows fails; repeated ids are kept for conflict handling', () => {
  const row = (id: string) => ({ id, createdDateTime: '2026-10-07T07:00:00Z' });
  assert.equal(parseM365SignInPage({ value: [row('a'), row('a')] }).length, 2);
  mismatch(() => parseM365SignInPage({ value: [row('a'), { id: 'b', createdDateTime: 'nope' }] }), 'signIn.createdDateTime');
  mismatch(() => parseM365SignInPage({ value: 'x' }), 'value');
  mismatch(() => parseM365SignInPage({ value: Array.from({ length: 501 }, (_, i) => row(`s${i}`)) }), 'value');
  assert.equal(parseM365SignInPage({ value: Array.from({ length: 500 }, (_, i) => row(`s${i}`)) }).length, 500);
});

test('opaque ids: bounds are exact and values are not altered', () => {
  assert.equal(requiredOpaqueId(' padded+/= ', 'f', 256), ' padded+/= ');
  mismatch(() => requiredOpaqueId('x'.repeat(5), 'f', 4), 'f');
});

test('strict UTC: calendar rollover, hour 24, offsets and zone-less text are rejected', () => {
  assert.equal(requiredUtcTime('2026-10-07T23:59:59Z', 't'), '2026-10-07T23:59:59.000Z');
  assert.equal(requiredUtcTime('2026-10-07T07:00:00.5Z', 't'), '2026-10-07T07:00:00.500Z');
  assert.equal(requiredUtcTime('2028-02-29T00:00:00Z', 't'), '2028-02-29T00:00:00.000Z');
  for (const bad of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-04-31T10:00:00Z', '2026-10-07T24:00:00Z', '2026-10-07T23:60:00Z',
    '2026-10-07T23:59:60Z', '2026-10-07T07:00:00+00:00', '2026-10-07T07:00:00+02:00', '2026-10-07T07:00:00', '2026-10-07', '2026-10-07 07:00:00Z',
    '2026-10-07T07:00Z', '2026-10-07T07:00:00z', '0050-01-01T00:00:00Z', '', null, undefined, 1760000000000, {}]) mismatch(() => requiredUtcTime(bad, 't'), 't');
});

test('UTC precision: distinct sub-millisecond instants stay distinct; equivalent fractions canonicalize identically', () => {
  const t = (fraction: string) => requiredUtcTime(`2026-10-07T07:15:30${fraction}Z`, 't');
  assert.equal(t('.1234567'), '2026-10-07T07:15:30.1234567Z');
  assert.notEqual(t('.1234567'), t('.1234568'), '100ns apart');
  assert.notEqual(t('.1234567'), t('.123'), 'nonzero digits beyond milliseconds are evidence');
  for (const same of ['', '.0', '.00', '.000', '.0000000']) assert.equal(t(same), '2026-10-07T07:15:30.000Z', same);
  for (const same of ['.5', '.50', '.500', '.5000000']) assert.equal(t(same), '2026-10-07T07:15:30.500Z', same);
  assert.equal(t('.1230000'), '2026-10-07T07:15:30.123Z');
  assert.equal(t('.1230001'), '2026-10-07T07:15:30.1230001Z');
  assert.equal(parseM365SignIn({ id: 's', createdDateTime: '2026-10-07T07:15:30.1000001Z' }).createdDateTime, '2026-10-07T07:15:30.1000001Z');
  mismatch(() => t('.12345678'), 't');
  mismatch(() => t('.'), 't');
});

test('Stage 1 helper behavior is unchanged by the M365 modules', () => {
  assert.equal(optionalTime('2026-10-07T07:00:00', 'f', true), '2026-10-07T07:00:00.000Z', 'shared lenient helper keeps its Stage 1 behavior');
  assert.deepEqual(atera.parseCustomerId({ CustomerID: 12 }), '12');
});

test('CorrelationContextV1 response type carries the approved envelope', () => {
  const context = {
    contractVersion: 'atlas.correlation.v1', mode: 'fixture', workspaceId: 'w', clientId: 'c', observationId: 'o', m365ConnectionId: 'm', ruleVersion: 'm365-correlation-v1',
    source: { eventKey: 'huntress:incident:1', severity: 'CRITICAL', priority: 'URGENT', route: 'HUMAN_REVIEW' },
    window: { fromInclusive: '2026-10-07T06:00:00.000Z', toExclusive: '2026-10-07T07:00:00.000Z' },
    resources: [{ resourceType: 'm365_signin', status: 'STALE', lastSuccessAt: null, asOf: null, safeErrorCode: null, coverage: 'COMPLETE' }],
    resolution: { device: 'RESOLVED', person: 'UNRESOLVED', reasonCodes: ['DIRECTORY_STALE'] },
    items: [{ evidenceRef: { sourceId: 's1', contentHash: 'h' }, occurredAt: '2026-10-07T06:30:00.000Z', relationCodes: ['DEVICE_REFERENCE'], evidenceState: 'CURRENT',
      proof: [{ relation: 'DEVICE_REFERENCE', vendorField: 'deviceDetail.deviceId', evidence: { sourceId: 's1', contentHash: 'h' }, linkIds: ['l'], linkStatuses: ['CONFIRMED'],
        directoryGenerationIds: ['g'], ruleVersion: 'm365-correlation-v1' }] }],
    coverage: { status: 'COMPLETE', traversalComplete: true, completedWindows: [], gaps: [], sourceScope: 'GRAPH_V1_USER_SIGNINS', assessedAt: '2026-10-07T07:30:00.000Z', freshness: 'STALE' },
    total: 1, truncated: false, nextCursor: null,
  } satisfies CorrelationContextV1;
  assert.equal(context.coverage.traversalComplete, context.coverage.status === 'COMPLETE');
  const noCoverage = { ...context, items: null } satisfies CorrelationContextV1;
  assert.equal(noCoverage.items, null);
});
