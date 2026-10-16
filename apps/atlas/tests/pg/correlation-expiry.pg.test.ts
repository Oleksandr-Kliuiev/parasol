import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { AtlasError } from '../../packages/core/contracts.ts';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { guid } from '../m365-sql-invariants.ts';
import { addActiveM365Connection, setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { LAPTOP, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishGeneration, publishScenarioDirectory, publishSignIns,
  readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C4a (tests/pg/correlation-expiry.pg.test.ts): with every pointer unchanged, a cursor expires at the earliest FUTURE
// transition — sign-in freshness, directory freshness or expiry, input eligibility (from + 7 days) and the expiry of a retained
// historical conflict version outside the interval — and the clock is re-evaluated on every page. Already stale data still
// issues a useful cursor. A narrower refresh never removes still-retained coverage; retrieval times stay the original ones.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
await addReader(pgdb.owner);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-e');
const EDGE_TENANT = guid('6');
await addActiveM365Connection(pgdb, 'edge-m365', EDGE_TENANT);
await pgdb.owner.query(`INSERT INTO "ExternalEntity" VALUES ($1,'demo-gasta','edge-device-07','edge-m365','m365_device',$2,'{}',now())`, [WS, LAPTOP]);
await pgdb.owner.query(`INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","method","status","confirmedBy",
  "confirmedAt","createdBy") VALUES ($1,'demo-gasta','link-edge','demo-device-07','edge-device-07','m365_device','DEVICE','MANUAL','CONFIRMED','demo-m365-reviewer',now(),'x')`, [WS]);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const claims = (cursor: string) => JSON.parse(Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8')) as { e: number };
const read = (from: Date, to: Date, extra: Record<string, unknown> = {}, connectionId = M365_CONNECTION) =>
  readCorrelation(db, reader, gasta, { connectionId, observationId: 'obs-e', from: from.toISOString(), to: to.toISOString(), ...extra }, readDeps());
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const dbNow = async () => Number((await pgdb.owner.query(`SELECT (extract(epoch FROM now()) * 1000)::float8 AS v`)).rows[0].v);
const until = async (ms: number) => { const wait = ms - await dbNow() + 250; if (wait > 0) await sleep(wait); };

test('C4a: sign-in freshness ends between pages → CORRELATION_CURSOR_EXPIRED; the stale data then issues a useful cursor', async () => {
  const R = hourStart(12);
  await publishSignIns(db, () => [signIn('f-1', iso(R, 60_000), OTHER_USER, REGISTRATION), signIn('f-2', iso(R, 120_000), OTHER_USER, REGISTRATION)], R, plus(R, 3_600_000),
    () => new Date(Date.now() - 15 * 60_000 + 6_000));
  const page = await read(R, plus(R, 3_600_000), { limit: 1 });
  assert.equal(page.coverage.freshness, 'FRESH');
  const e = claims(page.nextCursor!).e;
  assert.ok(e - await dbNow() <= 7_000, 'expiry bounded by the coming freshness transition');
  await until(e);
  await assert.rejects(read(R, plus(R, 3_600_000), { limit: 1, cursor: page.nextCursor }), fails('CORRELATION_CURSOR_EXPIRED'));
  const stale = await read(R, plus(R, 3_600_000), { limit: 1 });
  assert.deepEqual([stale.coverage.status, stale.coverage.freshness], ['COMPLETE', 'STALE']);
  assert.ok(claims(stale.nextCursor!).e - await dbNow() > 60_000, 'already stale data does not instantly expire a new cursor');
  assert.equal((await read(R, plus(R, 3_600_000), { limit: 1, cursor: stale.nextCursor })).items!.length, 1);
});

test('C4a: directory freshness and directory expiry between pages each expire the cursor, without any pointer change or cleanup', async () => {
  const R = hourStart(12);
  await publishSignIns(db, () => [signIn('d-1', iso(R, 60_000), OTHER_USER, REGISTRATION), signIn('d-2', iso(R, 120_000), OTHER_USER, REGISTRATION)], R, plus(R, 3_600_000),
    undefined, 'edge-m365', EDGE_TENANT);
  await publishGeneration(pgdb.owner, 'm365_device', 'edge-fresh-edge', [{ source: LAPTOP, mirror: 'edge-device-07', deviceId: REGISTRATION }], 3_600 - 6, 24 * 3600, 'edge-m365');
  const page = await read(R, plus(R, 3_600_000), { limit: 1 }, 'edge-m365');
  assert.deepEqual([page.resolution.device, page.resources[0]!.status], ['RESOLVED', 'OK']);
  await until(claims(page.nextCursor!).e);
  await assert.rejects(read(R, plus(R, 3_600_000), { limit: 1, cursor: page.nextCursor }, 'edge-m365'), fails('CORRELATION_CURSOR_EXPIRED'));
  const stale = await read(R, plus(R, 3_600_000), { limit: 1 }, 'edge-m365');
  assert.deepEqual([stale.resolution.device, stale.resolution.reasonCodes.includes('DIRECTORY_STALE'), stale.resources[0]!.status], ['RESOLVED', true, 'STALE']);
  await publishGeneration(pgdb.owner, 'm365_device', 'edge-expiring', [{ source: LAPTOP, mirror: 'edge-device-07', deviceId: REGISTRATION }], 60, 66, 'edge-m365');
  const expiring = await read(R, plus(R, 3_600_000), { limit: 1 }, 'edge-m365');
  assert.equal(expiring.resources[0]!.status, 'OK');
  await until(claims(expiring.nextCursor!).e);
  await assert.rejects(read(R, plus(R, 3_600_000), { limit: 1, cursor: expiring.nextCursor }, 'edge-m365'), fails('CORRELATION_CURSOR_EXPIRED'));
  const gone = await read(R, plus(R, 3_600_000), { limit: 1 }, 'edge-m365');
  assert.deepEqual([gone.resolution.device, gone.resolution.reasonCodes, gone.items, gone.resources[0]!.safeErrorCode],
    ['UNRESOLVED', ['ASSIGNED_PERSON_MAPPING_MISSING', 'DIRECTORY_EXPIRED'], [], 'DIRECTORY_EXPIRED']);
});

test('C4a: input eligibility (from + 7 days) and the expiry of a retained historical conflict version outside the interval bound the cursor', async () => {
  const now = await dbNow();
  const old = new Date(now - 7 * 86_400_000 + 20_000); const recent = hourStart(13);
  await publishSignIns(db, () => [signIn('h-old', old.toISOString(), OTHER_USER, REGISTRATION), signIn('h-old-2', plus(old, 1_000).toISOString(), OTHER_USER, REGISTRATION)],
    plus(old, -60_000), plus(old, 60_000));
  await publishSignIns(db, () => [signIn('h-old', iso(recent, 60_000), OTHER_USER, REGISTRATION), signIn('h-new', iso(recent, 120_000), OTHER_USER, REGISTRATION)],
    recent, plus(recent, 3_600_000));
  // Eligibility: from is 5s inside the seven days; the cursor ends when it falls out, and the same input is then refused.
  const from = plus(old, -15_000);
  const edge = await read(from, plus(old, 60_000), { limit: 1 });
  assert.deepEqual(edge.items!.map(i => i.evidenceRef.sourceId), ['h-old-2']);
  assert.ok(claims(edge.nextCursor!).e <= from.getTime() + 7 * 86_400_000);
  await until(claims(edge.nextCursor!).e);
  await assert.rejects(read(from, plus(old, 60_000), { limit: 1, cursor: edge.nextCursor }), fails('CORRELATION_CURSOR_EXPIRED'));
  await assert.rejects(read(from, plus(old, 60_000), { limit: 1 }), fails('CORRELATION_INTERVAL_NOT_RETAINED'));
  // Conflict: h-old of the recent root is CONFLICTED by its retained old version; that version's expiry bounds the cursor.
  const page = await read(recent, plus(recent, 3_600_000), { limit: 1 });
  assert.deepEqual(page.items!.map(i => [i.evidenceRef.sourceId, i.evidenceState]), [['h-new', 'CURRENT']]);
  const all = await read(recent, plus(recent, 3_600_000));
  assert.deepEqual(all.items!.map(i => [i.evidenceRef.sourceId, i.evidenceState]), [['h-new', 'CURRENT'], ['h-old', 'CONFLICTED']]);
  assert.ok(Math.abs(claims(page.nextCursor!).e - (old.getTime() + 7 * 86_400_000)) <= 1, 'expiry = the historical version leaving retention');
  await until(claims(page.nextCursor!).e);
  await assert.rejects(read(recent, plus(recent, 3_600_000), { limit: 1, cursor: page.nextCursor }), fails('CORRELATION_CURSOR_EXPIRED'));
  const after = await read(recent, plus(recent, 3_600_000));
  assert.deepEqual(after.items!.map(i => [i.evidenceRef.sourceId, i.evidenceState]), [['h-new', 'CURRENT'], ['h-old', 'CURRENT']],
    'query-time expiry: the old version no longer conflicts, although no cleanup ran');
  assert.equal((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365SignInEvidence" WHERE "sourceId" = 'h-old'`)).rows[0].n, 2);
});

test('C4a: a narrower refresh cannot remove still-retained coverage; retrieval time stays the original publication', async () => {
  const R = hourStart(2);
  const first = await publishSignIns(db, () => [signIn('w-1', iso(R, 60_000), OTHER_USER, REGISTRATION)], R, plus(R, 3_600_000), () => plus(R, 50 * 60_000));
  assert.deepEqual(first.results.map(r => r.outcome), ['PUBLISHED']);
  const narrower = await publishSignIns(db, () => [], R, plus(R, 3_600_000), () => plus(R, 30 * 60_000));
  assert.deepEqual(narrower.results.map(r => [r.outcome, r.safeErrorCode]), [['FAILED', 'M365_COVERAGE_NARROWED']]);
  const r = await read(R, plus(R, 3_600_000));
  assert.deepEqual(r.coverage.completedWindows.map(w => [w.fromInclusive.slice(0, 19), w.toExclusive.slice(0, 19), Date.parse(w.retrievedAt)]),
    [[R.toISOString().slice(0, 19), plus(R, 45 * 60_000).toISOString().slice(0, 19), plus(R, 50 * 60_000).getTime()]]);
  assert.deepEqual([r.coverage.status, r.coverage.gaps.map(g => g.reasonCode), r.items!.map(i => i.evidenceRef.sourceId)], ['PARTIAL', ['M365_WINDOW_NOT_COVERED'], ['w-1']]);
});
