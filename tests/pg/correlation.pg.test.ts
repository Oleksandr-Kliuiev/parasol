import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, LAPTOP, OTHER_DEVICE, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishScenarioDirectory, publishSignIns,
  readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C1 (tests/pg/correlation.pg.test.ts): the positive chain through the confined runtime role — confirmed Huntress agent →
// DEVICE → its confirmed m365_device link → directory device.deviceId (the registration key, never device.id) → sign-in
// deviceDetail.deviceId; and sign-in userId → directory user.id → confirmed PERSON. Exact proof fields, source unchanged.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
await addReader(pgdb.owner);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-c1');
const base = hourStart(3);
const end = new Date(base.getTime() + 3_600_000);
await publishSignIns(db, () => [
  signIn('s-device', iso(base, 60_000), OTHER_USER, REGISTRATION), signIn('s-person', iso(base, 120_000), KARI, OTHER_DEVICE),
  signIn('s-both', iso(base, 180_000), KARI, REGISTRATION), signIn('s-unrelated', iso(base, 240_000), OTHER_USER, OTHER_DEVICE),
  signIn('s-object-id', iso(base, 300_000), OTHER_USER, LAPTOP)], base, end);
const input = { connectionId: M365_CONNECTION, observationId: 'obs-c1', from: base.toISOString(), to: end.toISOString() };
const gens = async () => (await pgdb.owner.query(`SELECT "resourceType", "activeGenerationId" AS g FROM "M365ResourceState" WHERE "connectionId" = $1 ORDER BY 1`,
  [M365_CONNECTION])).rows as { resourceType: string; g: string }[];

test('C1: device chain via deviceId and person chain via userId resolve with exact proof; unrelated and directory-ID-only sign-ins are not selected', async () => {
  const r = await readCorrelation(db, reader, gasta, input, readDeps());
  assert.deepEqual([r.contractVersion, r.mode, r.ruleVersion, r.observationId, r.m365ConnectionId], ['atlas.correlation.v1', 'db', 'm365-correlation-v1', 'obs-c1', M365_CONNECTION]);
  assert.deepEqual(r.resolution, { device: 'RESOLVED', person: 'RESOLVED', reasonCodes: [] });
  assert.deepEqual(r.items!.map(i => [i.evidenceRef.sourceId, i.relationCodes, i.canonicalPersonId ?? null, i.evidenceState, i.statusCode]), [
    ['s-both', ['ASSIGNED_PERSON_ACTIVITY', 'DEVICE_REFERENCE', 'SIGNIN_USER_REFERENCE'], 'demo-kari', 'CURRENT', 0],
    ['s-person', ['ASSIGNED_PERSON_ACTIVITY', 'SIGNIN_USER_REFERENCE'], 'demo-kari', 'CURRENT', 0],
    ['s-device', ['DEVICE_REFERENCE'], null, 'CURRENT', 0]]);
  assert.deepEqual([r.total, r.truncated, r.nextCursor], [3, false, null]);
  const [{ g: device }, { g: user }] = (await gens()).filter(x => x.resourceType !== 'm365_signin');
  const both = r.items![0]!;
  assert.equal(both.occurredAt, new Date(base.getTime() + 180_000).toISOString(), 'canonical DTO time unchanged');
  assert.deepEqual(both.proof.map(p => ({ ...p, evidence: { ...p.evidence, contentHash: p.evidence.contentHash.length } })), [
    { relation: 'ASSIGNED_PERSON_ACTIVITY', vendorField: 'userId', evidence: { sourceId: 's-both', contentHash: 64 }, linkIds: ['huntress-confirmed-link', 'link-m365-user'],
      linkStatuses: ['CONFIRMED', 'CONFIRMED'], directoryGenerationIds: [user], ruleVersion: 'm365-correlation-v1' },
    { relation: 'DEVICE_REFERENCE', vendorField: 'deviceDetail.deviceId', evidence: { sourceId: 's-both', contentHash: 64 },
      linkIds: ['huntress-confirmed-link', 'link-m365-device'], linkStatuses: ['CONFIRMED', 'CONFIRMED'], directoryGenerationIds: [device], ruleVersion: 'm365-correlation-v1' },
    { relation: 'SIGNIN_USER_REFERENCE', vendorField: 'userId', evidence: { sourceId: 's-both', contentHash: 64 }, linkIds: ['link-m365-user'],
      linkStatuses: ['CONFIRMED'], directoryGenerationIds: [user], ruleVersion: 'm365-correlation-v1' }]);
  assert.deepEqual(r.source, { eventKey: r.source.eventKey, severity: 'CRITICAL', priority: 'URGENT', route: 'HUMAN_REVIEW' });
  assert.deepEqual(r.resources.map(x => [x.resourceType, x.status, x.safeErrorCode, x.coverage]),
    [['m365_device', 'OK', null, 'COMPLETE'], ['m365_user', 'OK', null, 'COMPLETE'], ['m365_signin', 'OK', null, 'COMPLETE']]);
  assert.deepEqual([r.coverage.status, r.coverage.traversalComplete, r.coverage.gaps, r.coverage.freshness, r.coverage.completedWindows.length],
    ['COMPLETE', true, [], 'FRESH', 1]);
  assert.deepEqual([r.window.fromInclusive, r.window.toExclusive], [`${base.toISOString().slice(0, 23)}0000Z`, `${end.toISOString().slice(0, 23)}0000Z`]);
});

test('C1: the read is audited as correlation.read with local IDs, counts, codes and version only; the observation is unchanged', async () => {
  const before = (await pgdb.owner.query(`SELECT severity, priority, route, status, "entityId" FROM "Observation" WHERE id = 'obs-c1'`)).rows[0];
  await readCorrelation(db, reader, gasta, input, { ...readDeps(), correlationId: 'corr-c1-audit' });
  const audit = (await pgdb.owner.query(`SELECT "actorId", metadata FROM "AuditEvent" WHERE "correlationId" = 'corr-c1-audit'`)).rows;
  assert.deepEqual(audit, [{ actorId: 'demo-m365-reader', metadata: { observationId: 'obs-c1', connectionId: M365_CONNECTION, ruleVersion: 'm365-correlation-v1',
    itemCount: '3', total: '3', coverageStatus: 'COMPLETE' } }]);
  assert.deepEqual((await pgdb.owner.query(`SELECT severity, priority, route, status, "entityId" FROM "Observation" WHERE id = 'obs-c1'`)).rows[0], before);
  const text = JSON.stringify((await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" LIKE 'correlation%'`)).rows);
  for (const canary of [KARI, REGISTRATION, LAPTOP, OTHER_USER, 's-both', 'synthetic@example.invalid']) assert.ok(!text.includes(canary), 'no vendor ID or DTO in audit');
});
