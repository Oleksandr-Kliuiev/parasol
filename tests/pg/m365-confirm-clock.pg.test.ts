import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { confirmLink } from '../../packages/graph/mapping.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { addMappingFixtures, gasta } from '../support/graph-fixtures.ts';
import { KARI_OBJECT, LAPTOP_OBJECT, M365_CONNECTION, addM365Fixtures, m365Actors, publishDirectory } from '../support/m365-fixtures.ts';
import { waitUntilBlocked } from '../support/pg-race.ts';

// Review S2-A-rc1 F3 on PostgreSQL 17: a new M365 confirmation decides freshness and payload expiry with the clock read
// AFTER every lock wait. The injected clock moves while confirmLink is provably blocked (pg_locks), so a decision made
// with the call-start time would differ: before the fix both crossing cases confirmed.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await addMappingFixtures(pgdb.owner);
await addM365Fixtures(pgdb.owner);
await publishDirectory(pgdb.owner, 'm365_user', 'gen-user-1', 1, [{ source: KARI_OBJECT, mirror: 'm365-user-kari' }], 5);
await publishDirectory(pgdb.owner, 'm365_device', 'gen-device-1', 1, [{ source: LAPTOP_OBJECT, mirror: 'm365-device-07' }], 5, 30);
// TIMESTAMP(3) columns hold UTC (as Prisma writes and reads them); epoch milliseconds avoid pg's local-time parsing.
const epochMs = async (sql: string, params: unknown[]) => Number((await pgdb.owner.query(sql, params)).rows[0].ms);
const completedAt = async (gen: string) => new Date(await epochMs(`SELECT (extract(epoch FROM "completedAt") * 1000)::float8 AS ms FROM "M365DirectoryGeneration" WHERE id = $1`, [gen]));
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const MINUTE = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;

/** confirmLink while another transaction holds the Connection fence; `during` runs once confirmLink is waiting on it. */
async function confirmAcrossLockWait(linkId: string, clock: { now: Date }, during: () => void) {
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl }); await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM "Connection" WHERE id = $1 FOR NO KEY UPDATE`, [M365_CONNECTION]);
    const reads: Date[] = [];
    const decision = confirmLink(db, m365Actors.m365Reviewer, gasta, linkId, () => { reads.push(clock.now); return clock.now; });
    decision.catch(() => undefined);
    await waitUntilBlocked(holder, null);
    assert.deepEqual(reads, [], 'no decision time was taken before the lock wait');
    during();
    await holder.query('COMMIT');
    return { decision, reads };
  } finally { await holder.end(); }
}

test('freshness crosses 60 minutes during the lock wait: the decision uses the time after the wait and refuses', async () => {
  const base = await completedAt('gen-user-1');
  const clock = { now: plus(base, 60 * MINUTE - 500) }; // just fresh when the call starts
  const { decision } = await confirmAcrossLockWait('link-m365-user', clock, () => { clock.now = plus(base, 60 * MINUTE + 500); });
  await assert.rejects(decision, fails('M365_DIRECTORY_NOT_FRESH'));
  assert.equal((await pgdb.owner.query(`SELECT status FROM "EntityLink" WHERE id = 'link-m365-user'`)).rows[0].status, 'CANDIDATE');
});

test('payload expiry crosses during the lock wait (expiry 30 minutes after completion): refused although still under 60 minutes', async () => {
  const base = await completedAt('gen-device-1');
  const clock = { now: plus(base, 30 * MINUTE - 500) };
  const { decision } = await confirmAcrossLockWait('link-m365-device', clock, () => { clock.now = plus(base, 30 * MINUTE + 500); });
  await assert.rejects(decision, fails('M365_DIRECTORY_NOT_FRESH'));
});

test('just fresh after the wait: confirmed, and the persisted decision time is the clock read after the locks', async () => {
  const base = await completedAt('gen-user-1');
  const clock = { now: plus(base, 59 * MINUTE) };
  const after = plus(base, 60 * MINUTE - 1_000);
  const { decision, reads } = await confirmAcrossLockWait('link-m365-user', clock, () => { clock.now = after; });
  assert.equal((await decision).status, 'CONFIRMED');
  assert.deepEqual(reads, [after], 'exactly one clock read, after the locks');
  const row = (await pgdb.owner.query(`SELECT (extract(epoch FROM "confirmedAt") * 1000)::float8 AS c, (extract(epoch FROM "reviewedAt") * 1000)::float8 AS r
    FROM "EntityLink" WHERE id = 'link-m365-user'`)).rows[0];
  assert.deepEqual([Number(row.c), Number(row.r)], [after.getTime(), after.getTime()]);
});
