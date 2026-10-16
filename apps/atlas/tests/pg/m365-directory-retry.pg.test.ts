import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { claimDirectoryGeneration, publishDirectoryGeneration, recordDirectoryFailure, syncM365Directory, traverseAndStage } from '../../packages/m365/directory.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, userRow } from '../support/m365-graph-mock.ts';
import type { Reply } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { guid } from '../m365-sql-invariants.ts';

// Review F6/F7 (S2-B repair) on PostgreSQL 17: a directory 429 delay is persisted (migration 202610081300) and respected
// across a fresh service/client/cache context — no claim, sequence, secret or upstream request before retryAt; explicit
// numeric and HTTP-date Retry-After above the ordinary cap and the bounded fallback; only the newest unexpired claim writes
// the throttle (SQL trigger as well); the hard job deadline comes from the persisted generation, not the descriptor.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-retry-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const throttled = (header?: string) => (url: URL): Reply | undefined => url.pathname !== '/v1.0/users' ? undefined
  : { status: 429, headers: header === undefined ? {} : { 'retry-after': header } };
const users = (url: URL) => url.pathname === '/v1.0/users' ? page([userRow(guid('1'))]) : undefined;
const state = async (id: string) => (await pgdb.owner.query(`SELECT "latestStartedSeq" AS started, "latestRecordedSeq" AS recorded, status, "safeErrorCode" AS code,
  (extract(epoch FROM "retryAt") * 1000)::float8 AS "retryAt" FROM "M365ResourceState" WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [id])).rows[0];

test('F6: Retry-After 5400s persists and is honoured by a fresh service context: no claim and no upstream request before it', async () => {
  const { id, tenant } = await fresh();
  const t0 = Math.floor(Date.now() / 1000) * 1000;
  const first = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: throttled('5400') })), at(t0));
  assert.deepEqual([first.status, first.safeErrorCode, first.retryAt!.getTime()], ['FAILED', 'M365_RATE_LIMITED', t0 + 5_400_000]);
  assert.deepEqual(await state(id), { started: 1, recorded: 1, status: 'ERROR', code: 'M365_RATE_LIMITED', retryAt: t0 + 5_400_000 });
  // A new process: another Prisma client, empty token cache, new transports
  const restarted = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
  try {
    m365TokenCache.clear();
    for (const offset of [MIN, 20 * MIN, 5_400_000 - 1]) {
      const mock = mockM365(tenant, { route: users });
      const error = await syncM365Directory(restarted, syncer, gasta, id, 'm365_user', ioOf(mock), at(t0 + offset)).catch(e => e) as AtlasError;
      assert.ok(fails('M365_RETRY_NOT_DUE')(error), String(offset));
      assert.equal(error.kind, 'TRANSIENT'); assert.equal(error.details.retryAt, new Date(t0 + 5_400_000).toISOString());
      assert.deepEqual(mock.requests, [], 'no secret use, token request or Graph call before retryAt');
    }
    assert.equal((await state(id)).started, 1, 'no sequence was allocated while throttled');
    const due = await syncM365Directory(restarted, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: users })), at(t0 + 5_400_000));
    assert.equal(due.status, 'PUBLISHED');
    assert.deepEqual(await state(id), { started: 2, recorded: 2, status: 'OK', code: null, retryAt: null }, 'publication clears the throttle');
  } finally { await restarted.$disconnect(); }
});

test('F6: an HTTP-date Retry-After two hours ahead is persisted exactly; a missing one falls back to 60s plus bounded jitter', async () => {
  const { id, tenant } = await fresh();
  const t0 = Math.floor(Date.now() / 1000) * 1000;
  const result = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: throttled(new Date(t0 + 7_200_000).toUTCString()) })), at(t0));
  assert.equal(result.retryAt!.getTime(), t0 + 7_200_000, 'not reduced to the 15m backoff cap or Stage 1’s one hour');
  assert.equal((await state(id)).retryAt, t0 + 7_200_000);
  const mock = mockM365(tenant, { route: users });
  await assert.rejects(syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mock), at(t0 + 3_600_000 + MIN)), fails('M365_RETRY_NOT_DUE'));
  assert.deepEqual(mock.requests, []);
  const other = await fresh();
  const fallback = await syncM365Directory(db, syncer, gasta, other.id, 'm365_user', ioOf(mockM365(other.tenant, { route: throttled() })), at(t0));
  const delay = fallback.retryAt!.getTime() - t0;
  assert.ok(delay >= 60_000 && delay <= 70_000, String(delay));
});

test('F6: older, superseded or expired claims cannot overwrite the newest throttle state; SQL refuses it as well', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  const older = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0));
  const newer = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0));
  const limited = await recordDirectoryFailure(db, syncer, newer, new AtlasError('M365_RATE_LIMITED', 'TRANSIENT', { retryAfterSeconds: '5400' }), at(t0));
  assert.deepEqual([limited.recorded, limited.retryAt!.getTime()], [true, t0 + 5_400_000]);
  // The superseded claim: neither a later 429 nor another failure changes the throttle
  assert.deepEqual(await recordDirectoryFailure(db, syncer, older, new AtlasError('M365_RATE_LIMITED', 'TRANSIENT', { retryAfterSeconds: '1' }), at(t0 + MIN)),
    { recorded: false, retryAt: null, attemptsUsed: 2, maxAttempts: 8 });
  assert.equal((await state(id)).retryAt, t0 + 5_400_000);
  // After retryAt: a new claim whose lease then expires cannot clear or replace it either
  const later = t0 + 5_400_000;
  const expiring = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(later));
  assert.deepEqual(await recordDirectoryFailure(db, syncer, expiring, new AtlasError('M365_RATE_LIMITED', 'TRANSIENT', { retryAfterSeconds: '60' }), at(later + 12 * MIN)),
    { recorded: false, retryAt: null, attemptsUsed: 3, maxAttempts: 8 });
  assert.equal((await state(id)).retryAt, t0 + 5_400_000, 'expired claim wrote nothing');
  // A superseded claim cannot clear it by publishing either
  const superseded = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(later + 13 * MIN));
  await traverseAndStage(db, syncer, superseded, ioOf(mockM365(tenant, { route: users })), at(later + 13 * MIN));
  await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(later + 13 * MIN));
  await assert.rejects(publishDirectoryGeneration(db, syncer, superseded, at(later + 13 * MIN)), fails('M365_ATTEMPT_SUPERSEDED'));
  assert.equal((await state(id)).retryAt, t0 + 5_400_000);
  // SQL: retryAt changes only together with the newest started attempt's recorded outcome; never on new or sign-in rows
  await assert.rejects(pgdb.owner.query(`UPDATE "M365ResourceState" SET "retryAt" = NULL WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [id]),
    /newest started attempt records its outcome/);
  await assert.rejects(pgdb.owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","retryAt")
    VALUES ('demo-vardahei','demo-gasta',$1,'m365_device',now())`, [id]), /new resource state carries no retry time/);
  await pgdb.owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq","status","safeErrorCode")
    VALUES ('demo-vardahei','demo-gasta',$1,'m365_signin',1,'UNAVAILABLE','M365_SIGNINS_NOT_AVAILABLE')`, [id]);
  await assert.rejects(pgdb.owner.query(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = 1, "retryAt" = now()
    WHERE "connectionId" = $1 AND "resourceType" = 'm365_signin'`, [id]), /M365ResourceState_retry_check/, 'never on the sign-in capability row');
});

test('F7: the directory hard deadline is the persisted start + 10m; changing the descriptor dates cannot extend it', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  const claim = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0));
  await traverseAndStage(db, syncer, claim, ioOf(mockM365(tenant, { route: users })), at(t0));
  claim.startedAt.setTime(t0 + 24 * 3_600_000); // the caller tampers with its copy
  await assert.rejects(publishDirectoryGeneration(db, syncer, claim, at(t0 + 10 * MIN + 1)), (e: unknown) => fails('SYNC_LIMIT_EXCEEDED')(e) && (e as AtlasError).details.limit === 'jobDeadline');
  const mock = mockM365(tenant, { route: users });
  await assert.rejects(traverseAndStage(db, syncer, claim, ioOf(mock), at(t0 + 11 * MIN)), fails('SYNC_LIMIT_EXCEEDED'));
  assert.deepEqual(mock.collectionGets(), [], 'past the persisted deadline no further page is requested');
  assert.equal((await pgdb.owner.query(`SELECT state FROM "M365DirectoryGeneration" WHERE id = $1`, [claim.generationId])).rows[0].state, 'STAGING');
});
