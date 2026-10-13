import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { injectedCursorKey, verifyCursor } from '../../packages/correlation/cursor.ts';
import { parseCorrelationInput, parseSignInListInput } from '../../packages/correlation/parameters.ts';
import { correlationPage, readCorrelation } from '../../packages/correlation/read.ts';
import { keyOfDate } from '../../packages/correlation/time.ts';
import { readSignIns, signInsPage } from '../../packages/m365/reads.ts';
import { withScope } from '../../packages/graph/scoped-db.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { CURSOR_SECRET, KARI, OTHER_DEVICE, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishScenarioDirectory, publishSignIns,
  readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// RC1 review findings R1/R2 (tests/pg/correlation-cursor-bounds.pg.test.ts), on BOTH cursor surfaces (correlation and
// microsoft365.signin.list): R1 — a transition later inside the snapshot clock's current millisecond is future and bounds the
// cursor, so the next page is CORRELATION_CURSOR_EXPIRED before interval validation (deterministic snapshot clock through the
// exported page bodies; the public services always use the database clock). R2 — a historical conflict contribution lasts only
// while it has a still-valid published membership: the cursor expires at the latest such membership's expiry (also when that
// precedes the evidence expiry, and across several memberships), never CHANGED by time alone.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
await addReader(pgdb.owner);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-b');
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const key = injectedCursorKey(CURSOR_SECRET);
const e = (cursor: string | null) => verifyCursor(key, cursor!).e;
const dbNow = async () => Number((await pgdb.owner.query(`SELECT (extract(epoch FROM date_trunc('milliseconds', now())) * 1000)::float8 AS v`)).rows[0].v);

test('R1: a sub-millisecond-future eligibility transition bounds both cursors; the next page expires before interval validation', async () => {
  const T = await dbNow(); const DAY7 = 7 * 86_400_000;
  const old = new Date(T - DAY7);
  await publishSignIns(db, () => [signIn('b-1', iso(old, 10 * 60_000), KARI, REGISTRATION), signIn('b-2', iso(old, 11 * 60_000), KARI, REGISTRATION)],
    new Date(old.getTime() + 5 * 60_000), new Date(old.getTime() + 20 * 60_000));
  const sub = (ms: number, digits: string) => `${new Date(ms).toISOString().slice(0, 23)}${digits}Z`;
  const first = { now: new Date(T), key: sub(T, '5000') };
  const next = { now: new Date(T), key: sub(T, '6000') };
  const raw = { connectionId: M365_CONNECTION, from: sub(T - DAY7, '5900'), to: new Date(T - DAY7 + 3_600_000).toISOString(), limit: 1 };
  const deps = readDeps();
  const run = <R>(fn: (tx: Parameters<Parameters<typeof withScope>[3]>[0]) => Promise<R>) => withScope(db, reader, ['demo-gasta'], fn);
  const corr = parseCorrelationInput({ ...raw, observationId: 'obs-b' });
  const list = parseSignInListInput(raw);
  const pageA = await run(tx => correlationPage(tx, reader, gasta, corr, key, null, deps, first));
  const pageB = await run(tx => signInsPage(tx, reader, gasta, list, key, null, deps, first));
  assert.deepEqual([pageA.total, pageB.total], [2, 2]);
  assert.deepEqual([e(pageA.nextCursor), e(pageB.nextCursor)], [T, T], 'floored transition within the current millisecond, never +15 minutes');
  await assert.rejects(run(tx => correlationPage(tx, reader, gasta, parseCorrelationInput({ ...raw, observationId: 'obs-b', cursor: pageA.nextCursor }), key,
    verifyCursor(key, pageA.nextCursor!), deps, next)), fails('CORRELATION_CURSOR_EXPIRED'));
  await assert.rejects(run(tx => signInsPage(tx, reader, gasta, parseSignInListInput({ ...raw, cursor: pageB.nextCursor }), key, verifyCursor(key, pageB.nextCursor!),
    deps, next)), fails('CORRELATION_CURSOR_EXPIRED'));
  await assert.rejects(run(tx => signInsPage(tx, reader, gasta, list, key, null, deps, next)), fails('CORRELATION_INTERVAL_NOT_RETAINED'),
    'a first page at the same clock is refused by interval validation');
  const later = { now: new Date(T), key: sub(T, '4000') };
  const fresh = await run(tx => signInsPage(tx, reader, gasta, list, key, null, deps, later));
  assert.equal(e(fresh.nextCursor), T, 'a transition later in the same millisecond is future');
});

/** Publication whose supersede of the previous attempt uses the schema-permitted shorter expiresAt (all triggers enabled). */
const superseding = (edge: Date) => db.$extends({ query: { m365WindowAttempt: { async update({ args, query }) {
  if ((args.data as { state?: string }).state === 'SUPERSEDED') (args.data as { expiresAt?: Date }).expiresAt = edge;
  return query(args);
} } } }) as unknown as PrismaClient;

test('R2: historical published-membership validity bounds and fingerprints both cursors — single membership, then the latest of several', async () => {
  const single = hourStart(5); const multi = hourStart(4); const span = 3_600_000;
  const row = (id: string, base: Date, code: number) => signIn(id, iso(base, 120_000), KARI, id.startsWith('m') ? REGISTRATION : OTHER_DEVICE, { status: { errorCode: code } });
  const stable = (id: string, base: Date) => signIn(id, iso(base, 60_000), KARI, REGISTRATION);
  // single: one historical membership with a short attempt expiry
  await publishSignIns(db, () => [row('s-hist', single, 0), stable('s-stable', single)], single, new Date(single.getTime() + span));
  const now0 = await dbNow();
  const edgeS = new Date(now0 + 7_000); const edge1 = new Date(now0 + 7_000); const edge2 = new Date(now0 + 14_000);
  await publishSignIns(superseding(edgeS), () => [row('s-hist', single, 50126), stable('s-stable', single)], single, new Date(single.getTime() + span));
  // multi: the historical version is a member of two superseded attempts (edge1, edge2); the latest validity counts
  await publishSignIns(db, () => [row('m-hist', multi, 0), stable('m-stable', multi)], multi, new Date(multi.getTime() + span));
  await publishSignIns(superseding(edge1), () => [row('m-hist', multi, 0), stable('m-stable', multi)], multi, new Date(multi.getTime() + span));
  await publishSignIns(superseding(edge2), () => [row('m-hist', multi, 50126), stable('m-stable', multi)], multi, new Date(multi.getTime() + span));
  const memberships = (await pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365WindowEvidence" m JOIN "M365SignInEvidence" v ON v.id = m."evidenceId"
    JOIN "M365WindowAttempt" a ON a.id = m."attemptId" WHERE v."sourceId" = 'm-hist' AND (v.dto->>'errorCode')::int = 0 AND a.state = 'SUPERSEDED'`)).rows[0].n;
  assert.equal(memberships, 2, 'the historical version is retained through two published attempts');
  const params = (base: Date) => ({ connectionId: M365_CONNECTION, from: base.toISOString(), to: new Date(base.getTime() + span).toISOString(), limit: 1 });
  const correlation = (base: Date, cursor?: string | null) => readCorrelation(db, reader, gasta, { ...params(base), observationId: 'obs-b', ...(cursor ? { cursor } : {}) }, readDeps());
  const listing = (base: Date, cursor?: string | null) => readSignIns(db, reader, gasta, { ...params(base), ...(cursor ? { cursor } : {}) }, readDeps());
  const s1 = await correlation(single); const s2 = await listing(single);
  const m1 = await correlation(multi); const m2 = await listing(multi); const m3 = await correlation(multi); const m4 = await listing(multi);
  assert.deepEqual([s1.items![0]!.evidenceState, s1.items![0]!.canonicalPersonId, s2.items![0]!.evidenceState], ['CONFLICTED', undefined, 'CONFLICTED']);
  for (const c of [s1, s2]) assert.equal(e(c.nextCursor), edgeS.getTime(), 'attempt expiry (before evidence expiry) bounds the cursor');
  for (const c of [m1, m2, m3, m4]) assert.equal(e(c.nextCursor), edge2.getTime(), 'the latest of several valid memberships bounds it');
  // After edge1 (one of two memberships gone) nothing visible changed: the multi cursors still page, neither CHANGED nor EXPIRED.
  await sleep(Math.max(0, edge1.getTime() - await dbNow() + 300));
  assert.deepEqual((await correlation(multi, m1.nextCursor)).items!.map(i => [i.evidenceRef.sourceId, i.evidenceState]), [['m-stable', 'CURRENT']]);
  assert.equal((await listing(multi, m2.nextCursor)).items!.length, 1);
  await assert.rejects(correlation(single, s1.nextCursor), fails('CORRELATION_CURSOR_EXPIRED'), 'EXPIRED, not CHANGED');
  await assert.rejects(listing(single, s2.nextCursor), fails('CORRELATION_CURSOR_EXPIRED'));
  const s3 = await correlation(single);
  assert.deepEqual([s3.items![0]!.evidenceState, s3.items![0]!.canonicalPersonId], ['CURRENT', 'demo-kari'], 'the contribution ended: annotation restored');
  await sleep(Math.max(0, edge2.getTime() - await dbNow() + 300));
  await assert.rejects(correlation(multi, m3.nextCursor), fails('CORRELATION_CURSOR_EXPIRED'));
  await assert.rejects(listing(multi, m4.nextCursor), fails('CORRELATION_CURSOR_EXPIRED'));
  const m5 = await listing(multi);
  assert.deepEqual([m5.total, m5.items![0]!.evidenceState, keyOfDate(new Date(e(m5.nextCursor))) > keyOfDate(edge2)], [2, 'CURRENT', true],
    'selection, count and coverage unchanged; only the conflict flag ended');
});
