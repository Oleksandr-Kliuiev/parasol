import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { readSignIns } from '../../packages/m365/reads.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, OTHER_DEVICE, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishScenarioDirectory, publishSignIns,
  readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C3 (tests/pg/correlation-provenance.pg.test.ts): assigned-person activity on another/absent device is labelled as person
// activity, never a device match; conflicting versions of one sign-in ID are CONFLICTED (published historical versions only,
// staged/unpublished ones never), neither is preferred for identity, both provenance chains stay; source urgency unchanged.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
await addReader(pgdb.owner);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-c3');
const base = hourStart(5); const end = new Date(base.getTime() + 3_600_000);
const at = (minutes: number) => iso(base, minutes * 60_000);
let rows = [signIn('p-other-device', at(1), KARI, OTHER_DEVICE), signIn('p-no-device', at(2), KARI, null),
  signIn('c-refresh', at(3), KARI, OTHER_DEVICE, { status: { errorCode: 0 } }), signIn('c-staged', at(4), OTHER_USER, REGISTRATION, { status: { errorCode: 0 } }),
  signIn('c-dup', at(5), KARI, REGISTRATION, { status: { errorCode: 0 } }), signIn('c-dup', at(5), KARI, REGISTRATION, { status: { errorCode: 50126 } })];
const first = await publishSignIns(db, () => rows, base, end);
assert.deepEqual(first.results.map(r => r.outcome), ['PUBLISHED']);
const input = { connectionId: M365_CONNECTION, observationId: 'obs-c3', from: base.toISOString(), to: end.toISOString() };
const byId = async () => new Map((await readCorrelation(db, reader, gasta, input, readDeps())).items!.map(i => [`${i.evidenceRef.sourceId}:${i.statusCode}`, i]));

test('C3: assigned-person activity with another or no device is ASSIGNED_PERSON_ACTIVITY (plus the sign-in user annotation), never DEVICE_REFERENCE', async () => {
  const items = await byId();
  for (const key of ['p-other-device:0', 'p-no-device:0']) {
    assert.deepEqual([items.get(key)!.relationCodes, items.get(key)!.canonicalPersonId, items.get(key)!.evidenceState],
      [['ASSIGNED_PERSON_ACTIVITY', 'SIGNIN_USER_REFERENCE'], 'demo-kari', 'CURRENT']);
  }
});

test('C3: two versions of one ID in the selected attempt are each CONFLICTED; no canonical person, selected relations and proofs retained', async () => {
  const items = await byId();
  for (const key of ['c-dup:0', 'c-dup:50126']) {
    const item = items.get(key)!;
    assert.deepEqual([item.evidenceState, item.relationCodes, item.canonicalPersonId], ['CONFLICTED', ['ASSIGNED_PERSON_ACTIVITY', 'DEVICE_REFERENCE'], undefined]);
    assert.deepEqual(item.proof.map(p => p.relation), ['ASSIGNED_PERSON_ACTIVITY', 'DEVICE_REFERENCE']);
  }
});

test('C3: a refresh returning another version marks the selected one CONFLICTED via the published (SUPERSEDED) old version; count/total only selected', async () => {
  rows = rows.map(r => (r.id === 'c-refresh' ? signIn('c-refresh', at(3), KARI, OTHER_DEVICE, { status: { errorCode: 70043 } }) : r));
  const refresh = await publishSignIns(db, () => rows, base, end);
  assert.deepEqual(refresh.results.map(r => r.outcome), ['PUBLISHED']);
  const states = (await pgdb.owner.query(`SELECT state, ("publishedAt" IS NOT NULL) AS published FROM "M365WindowAttempt" ORDER BY "attemptSeq"`)).rows;
  assert.deepEqual(states, [{ state: 'SUPERSEDED', published: true }, { state: 'COMPLETE', published: true }]);
  const r = await readCorrelation(db, reader, gasta, input, readDeps());
  const refreshed = r.items!.filter(i => i.evidenceRef.sourceId === 'c-refresh');
  assert.deepEqual(refreshed.map(i => [i.statusCode, i.evidenceState, i.canonicalPersonId ?? null, i.relationCodes]),
    [[70043, 'CONFLICTED', null, ['ASSIGNED_PERSON_ACTIVITY']]], 'only the selected version is an item; the historical one only flags it');
  assert.equal(r.total, 6, 'historical versions never add to the item count or total');
  const current = (await pgdb.owner.query(`SELECT id, (extract(epoch FROM "publishedAt") * 1000)::float8 AS at FROM "M365WindowAttempt" WHERE state = 'COMPLETE'`)).rows[0];
  assert.deepEqual(r.coverage.completedWindows.map(w => [w.publishedAttemptId, Date.parse(w.retrievedAt)]), [[current.id, Number(current.at)]],
    'exactly the current published attempt contributes, with its own retrieval time');
  const versions = (await pgdb.owner.query(`SELECT dto->'errorCode' AS code FROM "M365SignInEvidence" WHERE "sourceId" = 'c-refresh' ORDER BY 1`)).rows.map(x => x.code);
  assert.deepEqual(versions, [0, 70043], 'both immutable provenance chains remain stored');
  const list = await readSignIns(db, reader, gasta, { connectionId: M365_CONNECTION, from: input.from, to: input.to }, readDeps());
  assert.deepEqual(list.items!.filter(i => i.evidenceRef.sourceId === 'c-refresh').map(i => [i.dto.errorCode, i.evidenceState]), [[70043, 'CONFLICTED']]);
});

test('C3: versions only staged or in an unpublished (failed split) attempt never create visible conflicts', async () => {
  // A refresh that splits; the first half completes (membership written) with a changed c-staged version, the second half fails.
  const changed = rows.map(r => (r.id === 'c-staged' ? signIn('c-staged', at(4), OTHER_USER, REGISTRATION, { status: { errorCode: 999 } }) : r));
  const mid = new Date(base.getTime() + 30 * 60_000);
  const failedRefresh = await publishSignIns(db, () => changed, base, end, undefined, M365_CONNECTION, undefined,
    { pageSize: 4, inject: (from, _to, page) => (from.getTime() >= mid.getTime() && page === 0 ? { status: 503, body: {} } : undefined) },
    { leafLimits: { maxPagesPerLeaf: 1 } });
  assert.deepEqual(failedRefresh.results.map(r => [r.outcome, r.safeErrorCode]), [['RETRY', 'M365_UPSTREAM_UNAVAILABLE']], 'neither half is newly published');
  const staged = (await pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365WindowEvidence" m JOIN "M365WindowAttempt" a ON a.id = m."attemptId"
    JOIN "M365SignInEvidence" e ON e.id = m."evidenceId" WHERE e."sourceId" = 'c-staged' AND a.state = 'FAILED'`)).rows[0].n;
  assert.equal(staged, 1, 'the changed version is a member of the failed attempt only');
  const r = await readCorrelation(db, reader, gasta, input, readDeps());
  const item = r.items!.find(i => i.evidenceRef.sourceId === 'c-staged')!;
  assert.deepEqual([item.statusCode, item.evidenceState], [0, 'CURRENT']);
  assert.deepEqual([r.coverage.status, r.coverage.freshness, r.resources[2]!.status], ['COMPLETE', 'STALE', 'STALE'],
    'a newer failed refresh marks the retained portion STALE without replacing its retrieval time');
});

test('C3: source eventKey/severity/priority/route and observation triage stay unchanged by every read', async () => {
  const before = (await pgdb.owner.query(`SELECT o.severity, o.priority, o.route, o.status, o."updatedAt", r."eventKey" FROM "Observation" o JOIN "RawEvent" r ON r.id = o."eventId"
    WHERE o.id = 'obs-c3'`)).rows[0];
  const r = await readCorrelation(db, reader, gasta, input, readDeps());
  assert.deepEqual(r.source, { eventKey: before.eventKey, severity: 'CRITICAL', priority: 'URGENT', route: 'HUMAN_REVIEW' });
  assert.deepEqual((await pgdb.owner.query(`SELECT o.severity, o.priority, o.route, o.status, o."updatedAt", r."eventKey" FROM "Observation" o JOIN "RawEvent" r ON r.id = o."eventId"
    WHERE o.id = 'obs-c3'`)).rows[0], before);
  assert.equal((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "Observation"`)).rows[0].n, 1, 'no observation or incident is created');
});
