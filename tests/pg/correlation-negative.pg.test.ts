import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { readDirectory } from '../../packages/m365/reads.ts';
import { confirmLink } from '../../packages/graph/mapping.ts';
import { guid } from '../m365-sql-invariants.ts';
import { addActiveM365Connection, setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, LAPTOP, OTHER_DEVICE, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishGeneration, publishScenarioDirectory,
  publishSignIns, readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C2, C2a, C2b (+ the correlation half of C5b): identity never resolves through names, directory object IDs, other tenants,
// unconfirmed/rejected links, empty or duplicated references, missing/expired generations or the historical
// Observation.entityId. Each test starts from the canonical scenario (beforeEach) and changes one fact.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const GUEST = guid('1'); const SECOND_DEVICE = guid('2'); const OTHER_TENANT = guid('3');
const q = (sql: string, params: unknown[] = []) => pgdb.owner.query(sql, params);
const mirror = (id: string, type: string, externalId: string, connectionId = M365_CONNECTION) =>
  q(`INSERT INTO "ExternalEntity" VALUES ($1,'demo-gasta',$2,$3,$4,$5,'{}',now())`, [WS, id, connectionId, type, externalId]);
const link = (id: string, entityId: string, external: string, type: string, kind: string, status = 'CONFIRMED') =>
  q(`INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","method","status","confirmedBy","confirmedAt","createdBy")
     VALUES ($1,'demo-gasta',$2,$3,$4,$5,$6,'MANUAL',$7,'demo-m365-reviewer',now(),'demo-m365-reviewer')`, [WS, id, entityId, external, type, kind, status]);
const setStatus = (id: string, status: string) => q(`UPDATE "EntityLink" SET status = $2, "confirmedBy" = 'demo-m365-reviewer', "confirmedAt" = now(),
  "reviewedBy" = 'demo-m365-reviewer', "reviewedAt" = now(), "reasonCode" = CASE WHEN $2 IN ('REJECTED','QUARANTINED') THEN 'MANUAL_REJECT' END WHERE id = $1`, [id, status]);

await addReader(pgdb.owner);
await addActiveM365Connection(pgdb, 'other-m365', OTHER_TENANT);
await mirror('m365-guest', 'm365_user', GUEST); await mirror('m365-device-x', 'm365_device', SECOND_DEVICE);
await mirror('other-device-07', 'm365_device', LAPTOP, 'other-m365');
await link('link-guest-ola', 'demo-ola', 'm365-guest', 'm365_user', 'PERSON');
await link('link-device-x', 'demo-device-07', 'm365-device-x', 'm365_device', 'DEVICE', 'REJECTED');
await link('link-other-tenant', 'demo-device-07', 'other-device-07', 'm365_device', 'DEVICE');
await addHuntressObservation(pgdb.owner, 'obs-ok');
await addHuntressObservation(pgdb.owner, 'obs-no-ref', null);
await addHuntressObservation(pgdb.owner, 'obs-bad-ref', { resourceType: 'contact', externalId: 'demo-huntress-agent-207' });
await addHuntressObservation(pgdb.owner, 'obs-bad-id', { resourceType: 'agent', externalId: 'has space' });
await addHuntressObservation(pgdb.owner, 'obs-unknown-agent', { resourceType: 'agent', externalId: 'never-registered' });
await addHuntressObservation(pgdb.owner, 'obs-atera', { resourceType: 'agent', externalId: 'demo-atera-agent-107' }, 'demo-atera-connection', 'atera');
const base = hourStart(4); const end = new Date(base.getTime() + 3_600_000);
await publishSignIns(db, () => [signIn('s-device', iso(base, 60_000), OTHER_USER, REGISTRATION), signIn('s-kari', iso(base, 120_000), KARI, OTHER_DEVICE),
  signIn('s-guest', iso(base, 180_000), GUEST, REGISTRATION), signIn('s-object-id', iso(base, 240_000), OTHER_USER, LAPTOP),
  signIn('s-x', iso(base, 300_000), OTHER_USER, SECOND_DEVICE), signIn('s-none', iso(base, 360_000), null, null)], base, end);
const otherPass = await publishSignIns(db, () => [signIn('s-other-tenant', iso(base, 90_000), KARI, REGISTRATION)], base, end, undefined, 'other-m365', OTHER_TENANT);
assert.deepEqual(otherPass.results.map(r => r.outcome), ['PUBLISHED'], 'the other tenant really holds published evidence with the same references');
// A third connection used only for directory age: a generation can only be published newer than the previous one.
await addActiveM365Connection(pgdb, 'aged-m365', guid('4'));
await mirror('aged-device-07', 'm365_device', LAPTOP, 'aged-m365');
await link('link-aged-device', 'demo-device-07', 'aged-device-07', 'm365_device', 'DEVICE');

let generation = 0;
beforeEach(async () => {
  generation++;
  await q(`UPDATE "EntityLink" SET status = 'REJECTED', "reasonCode" = 'MANUAL_REJECT' WHERE id IN ('link-huntress-08', 'link-device-x', 'link-kari-2') AND status = 'CONFIRMED'`);
  await setStatus('huntress-confirmed-link', 'CONFIRMED');
  await confirmM365Links(pgdb.owner);
  await q(`UPDATE "Device" SET "personId" = 'demo-kari' WHERE id = 'demo-device-07'`);
  await publishGeneration(pgdb.owner, 'm365_device', `dev-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION },
    { source: SECOND_DEVICE, mirror: 'm365-device-x', deviceId: OTHER_DEVICE }]);
  await publishGeneration(pgdb.owner, 'm365_user', `usr-${generation}`, [{ source: KARI, mirror: 'm365-user-kari' }, { source: GUEST, mirror: 'm365-guest' }]);
});
const read = (observationId = 'obs-ok', connectionId = M365_CONNECTION) =>
  readCorrelation(db, reader, gasta, { connectionId, observationId, from: base.toISOString(), to: end.toISOString() }, readDeps());
const shape = async (observationId?: string) => {
  const r = await read(observationId);
  return { device: r.resolution.device, person: r.resolution.person, codes: r.resolution.reasonCodes, items: r.items?.map(i => `${i.evidenceRef.sourceId}:${i.relationCodes.join('+')}`) };
};

test('C2: baseline — device route by registration deviceId, person route by user.id; guest annotation is tenant-local and adds no selection', async () => {
  assert.deepEqual(await shape(), { device: 'RESOLVED', person: 'RESOLVED', codes: [],
    items: ['s-guest:DEVICE_REFERENCE+SIGNIN_USER_REFERENCE', 's-kari:ASSIGNED_PERSON_ACTIVITY+SIGNIN_USER_REFERENCE', 's-device:DEVICE_REFERENCE'] });
  const guest = (await read()).items!.find(i => i.evidenceRef.sourceId === 's-guest')!;
  assert.equal(guest.canonicalPersonId, 'demo-ola', 'guest user ID resolves only to its own tenant-local link; never ASSIGNED_PERSON_ACTIVITY');
});
test('C2: directory device.id ≠ deviceId, another tenant with the same object ID and a hostname-equal name never select or resolve', async () => {
  const r = await read();
  assert.ok(!r.items!.some(i => i.evidenceRef.sourceId === 's-object-id'), 'deviceDetail.deviceId equal to directory device.id is not a device reference');
  assert.ok(!r.items!.some(i => i.evidenceRef.sourceId === 's-other-tenant'), 'evidence of another connection/tenant is never selected');
  await setStatus('link-m365-device', 'CANDIDATE');
  // An unlinked directory device named exactly like the Huntress agent's hostname (GASTA-LT-07): a name is never evidence
  await publishGeneration(pgdb.owner, 'm365_device', `dev-named-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION, displayName: 'GASTA-LT-07' }]);
  assert.deepEqual((await shape()).device, 'UNRESOLVED');
  assert.ok((await shape()).codes.includes('M365_DEVICE_MAPPING_MISSING'), 'a confirmed link on the other tenant does not resolve the selected one');
});
test('C2: rejected, quarantined or second confirmed mapping; null and duplicated directory deviceId', async () => {
  await setStatus('link-m365-device', 'REJECTED');
  assert.deepEqual([(await shape()).device, (await shape()).codes], ['UNRESOLVED', ['M365_DEVICE_MAPPING_MISSING']]);
  await setStatus('link-m365-device', 'CONFIRMED'); await setStatus('link-device-x', 'CONFIRMED');
  const two = await shape();
  assert.deepEqual([two.device, two.person, two.codes, two.items], ['AMBIGUOUS', 'RESOLVED', ['M365_DEVICE_MAPPING_AMBIGUOUS'],
    ['s-kari:ASSIGNED_PERSON_ACTIVITY+SIGNIN_USER_REFERENCE']], 'two mappings: no device route, the person route stays independent');
  await setStatus('link-device-x', 'REJECTED');
  await publishGeneration(pgdb.owner, 'm365_device', `dev-null-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: null }]);
  assert.deepEqual([(await shape()).device, (await shape()).codes], ['UNRESOLVED', ['M365_DEVICE_REFERENCE_MISSING']]);
  assert.ok(!(await shape()).items!.some(i => i.startsWith('s-none')), 'an empty sign-in deviceId never matches a null directory deviceId');
  await publishGeneration(pgdb.owner, 'm365_device', `dev-dup-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION },
    { source: SECOND_DEVICE, mirror: 'm365-device-x', deviceId: REGISTRATION }]);
  assert.deepEqual([(await shape()).device, (await shape()).codes], ['AMBIGUOUS', ['M365_DEVICE_REFERENCE_AMBIGUOUS']]);
});
test('C2: disappeared identity is DIRECTORY_OBJECT_NOT_CURRENT; reappearance of the same opaque ID revives the confirmed link, never a rejected one', async () => {
  await publishGeneration(pgdb.owner, 'm365_device', `dev-gone-${generation}`, [{ source: SECOND_DEVICE, mirror: 'm365-device-x', deviceId: OTHER_DEVICE }]);
  assert.deepEqual([(await shape()).device, (await shape()).codes], ['UNRESOLVED', ['DIRECTORY_OBJECT_NOT_CURRENT']]);
  await publishGeneration(pgdb.owner, 'm365_device', `dev-back-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION }]);
  assert.equal((await shape()).device, 'RESOLVED');
  await setStatus('link-m365-device', 'REJECTED');
  await publishGeneration(pgdb.owner, 'm365_device', `dev-again-${generation}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION }]);
  assert.deepEqual([(await shape()).device, (await shape()).codes], ['UNRESOLVED', ['M365_DEVICE_MAPPING_MISSING']], 'a rejected link does not revive');
});
test('C2a: absent/invalid Huntress reference is UNRESOLVED for both paths with no Observation.entityId fallback; unknown agent is SOURCE_DEVICE_MAPPING_MISSING', async () => {
  assert.deepEqual(await shape('obs-no-ref'), { device: 'UNRESOLVED', person: 'UNRESOLVED', codes: ['SOURCE_DEVICE_REFERENCE_MISSING'], items: [] });
  assert.deepEqual(await shape('obs-bad-ref'), { device: 'UNRESOLVED', person: 'UNRESOLVED', codes: ['SOURCE_DEVICE_REFERENCE_INVALID'], items: [] });
  assert.deepEqual(await shape('obs-bad-id'), { device: 'UNRESOLVED', person: 'UNRESOLVED', codes: ['SOURCE_DEVICE_REFERENCE_INVALID'], items: [] });
  assert.deepEqual(await shape('obs-unknown-agent'), { device: 'UNRESOLVED', person: 'UNRESOLVED', codes: ['SOURCE_DEVICE_MAPPING_MISSING'], items: [] });
  await setStatus('huntress-confirmed-link', 'QUARANTINED');
  assert.deepEqual((await shape()).codes, ['SOURCE_DEVICE_MAPPING_MISSING'], 'quarantined source link never resolves');
  const r = await read('obs-no-ref');
  assert.deepEqual([r.coverage.status, r.total], ['COMPLETE', 0], 'coverage stays truthful; [] is not an all-clear');
});
test('C2a: a re-confirmed agent mapping after ingest uses the CURRENT device (dev-08, no person): never the stored entityId', async () => {
  await setStatus('huntress-confirmed-link', 'REJECTED');
  await link('link-huntress-08', 'dev-08', 'huntress-external-device', 'agent', 'DEVICE').catch(() => setStatus('link-huntress-08', 'CONFIRMED'));
  assert.deepEqual(await shape(), { device: 'UNRESOLVED', person: 'UNRESOLVED', codes: ['ASSIGNED_PERSON_MISSING', 'M365_DEVICE_MAPPING_MISSING'], items: [] });
  await setStatus('link-huntress-08', 'REJECTED');
});
test('C2/C3 person route: missing assignment, missing or ambiguous user mapping and missing user directory stay separate from the device route', async () => {
  await q(`UPDATE "Device" SET "personId" = NULL WHERE id = 'demo-device-07'`);
  const unassigned = await shape();
  assert.deepEqual([unassigned.device, unassigned.person, unassigned.codes, unassigned.items], ['RESOLVED', 'UNRESOLVED', ['ASSIGNED_PERSON_MISSING'],
    ['s-guest:DEVICE_REFERENCE+SIGNIN_USER_REFERENCE', 's-device:DEVICE_REFERENCE']], 's-kari is no longer selected: no third selection route');
  await q(`UPDATE "Device" SET "personId" = 'demo-kari' WHERE id = 'demo-device-07'`);
  await setStatus('link-m365-user', 'CANDIDATE');
  assert.deepEqual([(await shape()).person, (await shape()).codes], ['UNRESOLVED', ['ASSIGNED_PERSON_MAPPING_MISSING']]);
  await setStatus('link-m365-user', 'CONFIRMED');
  await mirror('m365-user-kari-2', 'm365_user', guid('5')).catch(() => undefined);
  await link('link-kari-2', 'demo-kari', 'm365-user-kari-2', 'm365_user', 'PERSON').catch(() => setStatus('link-kari-2', 'CONFIRMED'));
  assert.deepEqual([(await shape()).person, (await shape()).codes], ['AMBIGUOUS', ['ASSIGNED_PERSON_MAPPING_AMBIGUOUS']]);
});
test('C2b: confirmed membership at 61m resolves with STALE/DIRECTORY_STALE; at expiresAt it is UNRESOLVED/DIRECTORY_EXPIRED without cleanup, no DTO', async () => {
  await publishGeneration(pgdb.owner, 'm365_device', 'aged-stale', [{ source: LAPTOP, mirror: 'aged-device-07', deviceId: REGISTRATION }], 61 * 60, 24 * 3600, 'aged-m365');
  const stale = await read('obs-ok', 'aged-m365');
  assert.deepEqual([stale.resolution.device, stale.resolution.reasonCodes, stale.resources[0]!.status, stale.resources[0]!.safeErrorCode],
    ['RESOLVED', ['ASSIGNED_PERSON_MAPPING_MISSING', 'DIRECTORY_STALE'], 'STALE', 'DIRECTORY_STALE']);
  await mirror('aged-device-x', 'm365_device', SECOND_DEVICE, 'aged-m365');
  await link('link-aged-x', 'dev-08', 'aged-device-x', 'm365_device', 'DEVICE', 'CANDIDATE');
  await assert.rejects(confirmLink(db, m365Actors.m365Reviewer, gasta, 'link-aged-x'), (e: unknown) => e instanceof AtlasError && e.code === 'M365_DIRECTORY_NOT_FRESH',
    'a stale generation never accepts a new confirmation');
  await publishGeneration(pgdb.owner, 'm365_device', 'aged-expired', [{ source: LAPTOP, mirror: 'aged-device-07', deviceId: REGISTRATION }], 120, 120, 'aged-m365');
  const expired = await read('obs-ok', 'aged-m365');
  assert.deepEqual([expired.resolution.device, expired.resolution.reasonCodes, expired.resources[0]!.status, expired.resources[0]!.safeErrorCode, expired.resources[0]!.generationId],
    ['UNRESOLVED', ['ASSIGNED_PERSON_MAPPING_MISSING', 'DIRECTORY_EXPIRED'], 'MISSING', 'DIRECTORY_EXPIRED', undefined]);
  const list = await readDirectory(db, reader, gasta, { connectionId: 'aged-m365', resourceType: 'm365_device' }, readDeps());
  assert.deepEqual([list.items, list.total, list.resource.safeErrorCode], [null, 0, 'DIRECTORY_EXPIRED'], 'expired DTO hidden before any cleanup');
  assert.equal((await q(`SELECT count(*)::int AS n FROM "M365DirectoryObject" WHERE "generationId" = 'aged-expired'`)).rows[0].n, 1, 'rows still stored');
});
test('C2b: a newer pending directory attempt makes retained membership STALE without changing RESOLVED', async () => {
  await q(`UPDATE "M365ResourceState" SET "latestStartedSeq" = "latestStartedSeq" + 1, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`,
    [M365_CONNECTION]);
  const r = await read();
  assert.deepEqual([r.resolution.person, r.resolution.reasonCodes, r.resources[1]!.status], ['RESOLVED', ['DIRECTORY_STALE'], 'STALE']);
});
test('C2/C5b: no directory → DIRECTORY_MISSING; disabled source keeps historical evidence; disabled M365 refuses ordinary reads', async () => {
  // The other tenant's connection has a confirmed device link but no directory generation at all
  const other = await readCorrelation(db, reader, gasta, { connectionId: 'other-m365', observationId: 'obs-ok', from: base.toISOString(), to: end.toISOString() }, readDeps());
  assert.deepEqual([other.resolution.device, other.resolution.person, other.resolution.reasonCodes, other.resources.map(r => r.status)],
    ['UNRESOLVED', 'UNRESOLVED', ['ASSIGNED_PERSON_MAPPING_MISSING', 'DIRECTORY_MISSING'], ['MISSING', 'MISSING', 'OK']]);
  assert.deepEqual([other.items, other.total], [[], 0], 'its own published sign-ins exist, but nothing resolves to select them');
  await q(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'demo-huntress-connection'`);
  const r = await read();
  assert.ok(r.resolution.reasonCodes.includes('SOURCE_CONNECTION_DISABLED'), 'historical Huntress evidence is read with the explicit code');
  assert.equal(r.resolution.device, 'RESOLVED');
  await q(`UPDATE "Connection" SET status = 'FIXTURE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'demo-huntress-connection'`);
  await q(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  await assert.rejects(read(), (e: unknown) => e instanceof AtlasError && e.code === 'CONNECTION_NOT_LIVE');
  await q(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  await assert.rejects(read('obs-atera'), (e: unknown) => e instanceof AtlasError && e.code === 'CORRELATION_SOURCE_UNSUPPORTED');
  await assert.rejects(read('no-such-observation'), (e: unknown) => e instanceof AtlasError && e.code === 'OBSERVATION_NOT_FOUND');
  await assert.rejects(read('obs-ok', 'gasta-m365-fixture'), (e: unknown) => e instanceof AtlasError && e.code === 'FIXTURE_CONNECTION_NOT_SUPPORTED');
});
