import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { Aliases, assertSafeTree, projectResult } from '../packages/ops/pilot/project.ts';
import type { PilotCommand } from '../packages/ops/pilot/config.ts';
import { CANARY } from './support/pilot-support.ts';

// Allowlisted public projection (operational brief RC5): statuses/codes/counts/time bounds, relation/proof labels and
// run-local aliases only. Synthetic service outputs carry canary personal/vendor/local identifiers, cursors and hashes;
// none may survive into the projection, while counts, statuses and proof labels stay truthful.
const failsWith = (code: string) => (error: unknown) => error instanceof AtlasError && error.code === code;
const LOCAL = { connection: 'conn-canary-77', request: 'req-canary-88', window: 'win-canary-99', generation: 'gen-canary-55', observation: 'obs-canary-44',
  link: 'link-canary-33', entity: 'entity-canary-22', external: 'ext-canary-11', event: 'evkey-canary-66', hash: 'Zm9vYmFyY2FuYXJ5aGFzaA', cursor: 'v1.canary-cursor.mac' };
const T = '2026-10-08T10:00:00.000Z'; const U = '2026-10-08T11:00:00.000Z';
const canaries = [...Object.values(CANARY), ...Object.values(LOCAL)];
const project = (command: PilotCommand, output: unknown, flags: Record<string, string> = { client: 'pilot-client', connection: LOCAL.connection }) => {
  const aliases = new Aliases();
  const result = projectResult(command, output, aliases, flags);
  const text = JSON.stringify(result);
  for (const canary of canaries) assert.ok(!text.includes(canary), `${command}: ${canary}`);
  return { result: result as Record<string, any>, aliases };
};
const resource = (type: string) => ({ resourceType: type, status: 'OK', lastSuccessAt: T, asOf: T, safeErrorCode: null, generationId: LOCAL.generation, coverage: 'COMPLETE' });

test('directory list: approved DTOs (names, UPNs, object IDs) become presence/counts; the cursor only a presence flag', () => {
  const items = [1, 2, 3].map(n => ({ id: `${CANARY.app}`, displayName: `${CANARY.name} ${n}`, userPrincipalName: CANARY.upn, userType: 'Member', accountEnabled: true }));
  const { result, aliases } = project('m365-directory', { contractVersion: 'atlas.m365-directory.v1', mode: 'db', workspaceId: 'pilot-ws', clientId: 'pilot-client',
    m365ConnectionId: LOCAL.connection, resourceType: 'm365_user', resource: resource('m365_user'), items, total: 7, truncated: true, nextCursor: LOCAL.cursor },
  { client: 'pilot-client', connection: LOCAL.connection, resource: 'users', limit: '3' });
  assert.deepEqual(result, { contractVersion: 'atlas.m365-directory.v1', connection: 'connection-1', resourceType: 'm365_user',
    resource: { resourceType: 'm365_user', status: 'OK', coverage: 'COMPLETE', lastSuccessAt: T, asOf: T, safeErrorCode: null, generation: 'generation-1' },
    itemsPresent: true, itemCount: 3, total: 7, truncated: true, nextCursorPresent: true });
  assert.deepEqual(aliases.privateEntries(), [['connection-1', LOCAL.connection], ['generation-1', LOCAL.generation]], 'the alias map stays private');
  const unavailable = project('m365-directory', { contractVersion: 'atlas.m365-directory.v1', m365ConnectionId: LOCAL.connection, resourceType: 'm365_device',
    resource: { ...resource('m365_device'), status: 'MISSING', generationId: undefined, coverage: 'UNAVAILABLE' }, items: null, total: 0, truncated: false, nextCursor: null });
  assert.deepEqual([unavailable.result.itemsPresent, unavailable.result.itemCount], [false, null], 'unavailable is not an empty list');
});

test('correlation: relation/proof labels, coverage and resolution stay truthful; evidence IDs, hashes, link IDs, person IDs and event keys never appear', () => {
  const proof = (relation: string, vendorField: string) => ({ relation, vendorField, evidence: { sourceId: CANARY.app, contentHash: LOCAL.hash },
    linkIds: [LOCAL.link, `${LOCAL.link}-2`], linkStatuses: ['CONFIRMED', 'CONFIRMED'], directoryGenerationIds: [LOCAL.generation], ruleVersion: 'm365-correlation-v1' });
  const output = { contractVersion: 'atlas.correlation.v1', mode: 'db', workspaceId: 'pilot-ws', clientId: 'pilot-client', observationId: LOCAL.observation,
    m365ConnectionId: LOCAL.connection, ruleVersion: 'm365-correlation-v1', source: { eventKey: LOCAL.event, severity: 'HIGH', priority: 'URGENT', route: 'HUMAN_REVIEW' },
    window: { fromInclusive: T, toExclusive: U }, resources: [resource('m365_user'), resource('m365_device'), { ...resource('m365_signin'), generationId: undefined }],
    resolution: { device: 'RESOLVED', person: 'UNRESOLVED', reasonCodes: ['ASSIGNED_PERSON_MISSING'] },
    items: [{ evidenceRef: { sourceId: CANARY.app, contentHash: LOCAL.hash }, occurredAt: T, statusCode: 50126, canonicalPersonId: LOCAL.entity,
      relationCodes: ['DEVICE_REFERENCE', 'SIGNIN_USER_REFERENCE'], proof: [proof('DEVICE_REFERENCE', 'deviceDetail.deviceId'), proof('SIGNIN_USER_REFERENCE', 'userId')],
      evidenceState: 'CURRENT' }],
    coverage: { status: 'PARTIAL', traversalComplete: false, completedWindows: [{ rootWindowId: LOCAL.window, publishedAttemptId: LOCAL.request, fromInclusive: T, toExclusive: U,
      retrievedAt: T, freshness: 'FRESH' }], gaps: [{ fromInclusive: T, toExclusive: U, reasonCode: 'WINDOW_NOT_PUBLISHED' }], sourceScope: 'GRAPH_V1_USER_SIGNINS', assessedAt: U, freshness: 'FRESH' },
    total: 1, truncated: false, nextCursor: null };
  const { result } = project('correlation', output, { client: 'pilot-client', connection: LOCAL.connection, observation: LOCAL.observation, from: T, to: U });
  assert.deepEqual([result.observation, result.connection, result.source], ['observation-1', 'connection-1', { severity: 'HIGH', priority: 'URGENT', route: 'HUMAN_REVIEW' }]);
  assert.deepEqual(result.resolution, { device: 'RESOLVED', person: 'UNRESOLVED', reasonCodes: ['ASSIGNED_PERSON_MISSING'] });
  assert.deepEqual(result.coverage, { status: 'PARTIAL', traversalComplete: false, freshness: 'FRESH', sourceScope: 'GRAPH_V1_USER_SIGNINS', assessedAt: U, completedWindows: 1,
    gaps: [{ fromInclusive: T, toExclusive: U, reasonCode: 'WINDOW_NOT_PUBLISHED' }] });
  assert.deepEqual(result.relations, [{ relationCodes: ['DEVICE_REFERENCE', 'SIGNIN_USER_REFERENCE'], evidenceState: 'CURRENT', canonicalPersonPresent: true, proof: [
    { relation: 'DEVICE_REFERENCE', vendorField: 'deviceDetail.deviceId', linkStatuses: ['CONFIRMED', 'CONFIRMED'], linkCount: 2, directoryGenerationCount: 1 },
    { relation: 'SIGNIN_USER_REFERENCE', vendorField: 'userId', linkStatuses: ['CONFIRMED', 'CONFIRMED'], linkCount: 2, directoryGenerationCount: 1 }] }]);
  assert.deepEqual([result.itemsPresent, result.itemCount, result.total], [true, 1, 1]);
  assert.ok(!JSON.stringify(result).includes('50126') && !JSON.stringify(result).includes('occurredAt'), 'no per-sign-in status or activity time');
  const none = project('correlation', { ...output, items: null, coverage: { ...output.coverage, status: 'UNAVAILABLE', completedWindows: [] }, total: 0 },
    { client: 'pilot-client', connection: LOCAL.connection, observation: LOCAL.observation, from: T, to: U });
  assert.deepEqual([none.result.relations, none.result.itemsPresent], [null, false]);
});

test('mapping, confirm-link, status, sync and probe: local IDs become aliases; vendor IDs, entity IDs and actors are dropped', () => {
  const item = { linkId: LOCAL.link, status: 'CANDIDATE', resourceType: 'm365_device', entityKind: 'DEVICE', entityId: LOCAL.entity, externalEntityId: LOCAL.external,
    connectionId: LOCAL.connection, system: 'microsoft365', externalId: CANARY.app, method: 'MANUAL', createdBy: CANARY.name, createdAt: T, reviewedBy: CANARY.upn,
    reviewedAt: null, reasonCode: null, conflictsWithLinkId: null };
  const mapping = project('mapping', { items: [item, { ...item, linkId: `${LOCAL.link}-b`, status: 'QUARANTINED', reasonCode: 'CONFLICT', conflictsWithLinkId: LOCAL.link }] },
    { client: 'pilot-client' });
  assert.deepEqual(mapping.result, { itemCount: 2, items: [
    { link: 'link-1', status: 'CANDIDATE', resourceType: 'm365_device', entityKind: 'DEVICE', system: 'microsoft365', method: 'MANUAL', reasonCode: null, conflictsWith: null },
    { link: 'link-2', status: 'QUARANTINED', resourceType: 'm365_device', entityKind: 'DEVICE', system: 'microsoft365', method: 'MANUAL', reasonCode: 'CONFLICT', conflictsWith: 'link-1' }] });
  const confirm = project('confirm-link', { linkId: LOCAL.link, status: 'CONFIRMED', conflictsWithLinkId: null }, { client: 'pilot-client', link: LOCAL.link });
  assert.deepEqual(confirm.result, { link: 'link-1', status: 'CONFIRMED', conflictsWith: null });
  const status = project('m365-status', { connectionId: LOCAL.connection, connectionStatus: 'ACTIVE', lifecycleVersion: 3, assessedAt: T,
    directory: [{ resourceType: 'm365_user', status: 'OK', reasonCodes: [], attemptsUsed: 0, maxAttempts: 8, retryAt: null, lastAttemptAt: T, lastSuccessAt: T,
      activeGenerationId: LOCAL.generation, rowCount: 12 }],
    signIns: { capability: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE', windows: { total: 2, ok: 1, error: 0, pending: 1, missing: 0 } },
    request: { requestId: LOCAL.request, outcome: 'IN_PROGRESS', rootCount: 1, createdAt: T, requestedFrom: T, requestedTo: U, retrievalFrom: T, retrievalTo: U, configVersion: 'm365-v1',
      totalLeaves: 1, totalStagedRows: 0, roots: [{ windowId: LOCAL.window, rootFrom: T, state: 'PENDING', attemptsUsed: 1, maxAttempts: 5, retryAt: U, safeErrorCode: 'M365_RATE_LIMITED' }] } });
  assert.deepEqual([status.result.connection, status.result.directory[0].generation, status.result.request.request, status.result.request.roots[0].window],
    ['connection-1', 'generation-1', 'request-1', 'window-1']);
  const sync = project('m365-sync', { mode: 'create', requestId: LOCAL.request, retrievalFrom: T, retrievalTo: U, roots: [{ windowId: LOCAL.window, rootFrom: T,
    outcome: 'RETRY', attemptSeq: 1, safeErrorCode: 'M365_RATE_LIMITED', retryAt: U, evidenceCount: null, attemptsUsed: 1, maxAttempts: 5 }] },
  { client: 'pilot-client', connection: LOCAL.connection, resource: 'signins', from: '2026-10-08T10:15:00Z', to: '2026-10-08T10:45:00.000Z' });
  assert.deepEqual([sync.result.request, sync.result.requestedFrom, sync.result.requestedTo, sync.result.retrievalFrom, sync.result.roots[0].outcome],
    ['request-1', '2026-10-08T10:15:00.000Z', '2026-10-08T10:45:00.000Z', T, 'RETRY'], 'requested and effective intervals both recorded');
  const directory = project('m365-sync', { resourceType: 'm365_device', status: 'FAILED', attemptSeq: 2, generationId: LOCAL.generation, rowCount: null, recorded: true,
    safeErrorCode: 'M365_ACCESS_DENIED', errorKind: 'PERMANENT', retryAfterSeconds: null, retryAt: null, attemptsUsed: 2, maxAttempts: 8 },
  { client: 'pilot-client', connection: LOCAL.connection, resource: 'devices' });
  assert.deepEqual([directory.result.mode, directory.result.status, directory.result.safeErrorCode], ['directory', 'FAILED', 'M365_ACCESS_DENIED'], 'a 403 is only its code');
  const probe = project('m365-probe', { status: 'ACTIVE', connectionId: LOCAL.connection, lifecycleVersion: 2, signIns: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE' });
  assert.deepEqual(probe.result, { status: 'ACTIVE', connection: 'connection-1', lifecycleVersion: 2, signIns: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE' });
  const live = project('live-read', { connectionId: LOCAL.connection, system: 'huntress', activation: { status: 'ACTIVE' }, health: { status: 'OK', safeErrorCode: null },
    identities: { status: 'OK', registered: 2, candidates: 0, ambiguous: 0, safeErrorCode: null },
    resources: [{ resourceType: 'incident', status: 'OK', itemCount: 3, eventsStored: 3, safeErrorCode: null, retryAfterSeconds: null }] });
  assert.deepEqual([live.result.connection, live.result.identities.registered, live.result.resources[0].itemCount], ['connection-1', 2, 3]);
});

test('anything unexpected refuses the whole projection instead of passing through', () => {
  const probe = { status: 'DISABLED', connectionId: 'c', safeErrorCode: 'M365_AUTH_FAILED' };
  const refusedCases: [PilotCommand, unknown][] = [
    ['m365-probe', { ...probe, safeErrorCode: CANARY.upn }], ['m365-probe', { ...probe, status: 'PASS' }], ['m365-probe', 'not an object'],
    ['confirm-link', { linkId: 'l', status: `Confirmed by ${CANARY.name}`, conflictsWithLinkId: null }],
    ['live-read', { connectionId: 'c', system: 'poweroffice', activation: { status: 'ACTIVE' }, health: null, identities: null, resources: [] }],
    ['mapping', { items: [{ linkId: 'l', status: 'CANDIDATE', resourceType: 'hostname:GASTA', entityKind: 'DEVICE', system: 'huntress', method: 'MANUAL' }] }],
  ];
  for (const [command, output] of refusedCases) {
    assert.throws(() => projectResult(command, output, new Aliases(), { client: 'pilot-client', connection: 'c', link: 'l' }), failsWith('PILOT_PROJECTION_REFUSED'), JSON.stringify(output));
  }
  for (const value of [{ x: CANARY.name }, { x: 'https://graph.microsoft.com/v1.0/users' }, { x: CANARY.upn }, { 'a b': 1 }, { x: [{ y: 'GASTA-LT-07' }] }, { x: new Date() }]) {
    assert.throws(() => assertSafeTree(value), failsWith('PILOT_PROJECTION_REFUSED'), JSON.stringify(value));
  }
  assert.doesNotThrow(() => assertSafeTree({ a: 'M365_RATE_LIMITED', b: '2026-10-08T10:00:00.000Z', c: 'request-3', d: '120', e: 'm365_user', f: null, g: [true, 1] }));
});
