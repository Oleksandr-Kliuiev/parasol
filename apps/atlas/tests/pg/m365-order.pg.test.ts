import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { claimDirectoryGeneration, publishDirectoryGeneration, recordDirectoryFailure, traverseAndStage } from '../../packages/m365/directory.ts';
import type { DirectoryClaim } from '../../packages/m365/directory.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, userRow } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, directoryState, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { inFlight, waitUntilBlocked } from '../support/pg-race.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 2 task 2.5, B4 on PostgreSQL 17: overlapping first and later directory syncs with identical timestamps, both
// finish orders, success/error mixes, expired (lost) claims and the Connection fence against a concurrent disable.
// The newest started attempt alone may record or publish; an older one can neither replace its success nor its failure.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-ord-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: Date) => () => t;
async function stage(claim: DirectoryClaim, tenant: string, users: string[], clock: () => Date): Promise<void> {
  m365TokenCache.clear();
  await traverseAndStage(db, syncer, claim, ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/users' ? page(users.map(u => userRow(u))) : undefined })), clock);
}
const state = (id: string) => directoryState(pgdb, 'm365_user', id).then(s => ({ started: s.started, recorded: s.recorded, published: s.published, active: s.active, status: s.status, code: s.code }));
const genState = async (id: string) => (await pgdb.owner.query(`SELECT state FROM "M365DirectoryGeneration" WHERE id = $1`, [id])).rows[0].state;

test('overlapping FIRST syncs with the same timestamp get distinct sequences atomically, also when claimed concurrently', async () => {
  const { id } = await fresh();
  const t = new Date();
  const claims = await Promise.all([1, 2, 3].map(() => claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t))));
  assert.deepEqual(claims.map(x => x.attemptSeq).sort(), [1, 2, 3]);
  assert.deepEqual(await state(id), { started: 3, recorded: 0, published: 0, active: null, status: 'PENDING', code: null });
});

for (const order of ['newer-first', 'older-first'] as const) {
  test(`same-timestamp first syncs, ${order}: the newest started attempt wins, the lost claim cannot publish or record`, async () => {
    const { id, tenant } = await fresh();
    const t = new Date();
    const a = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
    await stage(a, tenant, [guid('1')], at(t)); // A read everything before B started
    const b = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
    await assert.rejects(stage(a, tenant, [guid('9')], at(t)), fails('M365_ATTEMPT_SUPERSEDED'), 'a superseded claim cannot even stage');
    await stage(b, tenant, [guid('2')], at(t));
    if (order === 'newer-first') {
      await publishDirectoryGeneration(db, syncer, b, at(t));
      await assert.rejects(publishDirectoryGeneration(db, syncer, a, at(t)), fails('M365_ATTEMPT_SUPERSEDED'));
    } else {
      await assert.rejects(publishDirectoryGeneration(db, syncer, a, at(t)), fails('M365_ATTEMPT_SUPERSEDED'));
      await publishDirectoryGeneration(db, syncer, b, at(t));
    }
    assert.equal((await recordDirectoryFailure(db, syncer, a, 'M365_ATTEMPT_SUPERSEDED', at(t))).recorded, false, 'the lost claim records nothing for its successor');
    assert.deepEqual(await state(id), { started: 2, recorded: 2, published: 2, active: b.generationId, status: 'OK', code: null });
    assert.deepEqual([await genState(a.generationId), await genState(b.generationId)], ['FAILED', 'PUBLISHED']);
  });
}

test('later syncs: a newer failure is never turned into OK by an older completion; an older failure never replaces a newer success', async () => {
  const { id, tenant } = await fresh();
  const t = new Date();
  const first = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  await stage(first, tenant, [guid('1')], at(t)); await publishDirectoryGeneration(db, syncer, first, at(t));
  // Newer fails first, older then tries to complete
  const older = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  await stage(older, tenant, [guid('1'), guid('2')], at(t));
  const newer = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  assert.equal((await recordDirectoryFailure(db, syncer, newer, 'M365_UPSTREAM_UNAVAILABLE', at(t))).recorded, true);
  await assert.rejects(publishDirectoryGeneration(db, syncer, older, at(t)), fails('M365_ATTEMPT_SUPERSEDED'));
  assert.equal((await recordDirectoryFailure(db, syncer, older, 'M365_ATTEMPT_SUPERSEDED', at(t))).recorded, false);
  assert.deepEqual(await state(id), { started: 3, recorded: 3, published: 1, active: first.generationId, status: 'ERROR', code: 'M365_UPSTREAM_UNAVAILABLE' });
  // Newer succeeds, older fails afterwards
  const older2 = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  const newer2 = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  await stage(newer2, tenant, [guid('3')], at(t)); await publishDirectoryGeneration(db, syncer, newer2, at(t));
  assert.equal((await recordDirectoryFailure(db, syncer, older2, 'M365_UPSTREAM_UNAVAILABLE', at(t))).recorded, false);
  assert.deepEqual(await state(id), { started: 5, recorded: 5, published: 5, active: newer2.generationId, status: 'OK', code: null });
});

test('an expired claim cannot publish or record, even before any successor exists; the successor then publishes', async () => {
  const { id, tenant } = await fresh();
  const t = new Date();
  const lost = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t));
  await stage(lost, tenant, [guid('1')], at(t));
  const later = new Date(t.getTime() + 12 * 60_000);
  await assert.rejects(publishDirectoryGeneration(db, syncer, lost, at(later)), fails('M365_CLAIM_EXPIRED'));
  assert.equal((await recordDirectoryFailure(db, syncer, lost, 'M365_CLAIM_EXPIRED', at(later))).recorded, false);
  assert.equal(await genState(lost.generationId), 'FAILED', 'only its own generation is closed');
  assert.deepEqual(await state(id), { started: 1, recorded: 0, published: 0, active: null, status: 'PENDING', code: null });
  const successor = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(later));
  await stage(successor, tenant, [guid('2')], at(later));
  await publishDirectoryGeneration(db, syncer, successor, at(later));
  assert.equal((await state(id)).active, successor.generationId);
});

test('B1b: a disable that wins the Connection lock makes the waiting publication fail; the retained pointer is unchanged', async () => {
  const { id, tenant } = await fresh();
  const first = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user');
  await stage(first, tenant, [guid('1')], () => new Date()); await publishDirectoryGeneration(db, syncer, first);
  const claim = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user');
  await stage(claim, tenant, [guid('2')], () => new Date());
  const disabler = new pg.Client({ connectionString: pgdb.ownerUrl }); await disabler.connect();
  try {
    await disabler.query('BEGIN');
    await disabler.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [id]);
    const publishing = inFlight(() => publishDirectoryGeneration(db, syncer, claim));
    await waitUntilBlocked(pgdb.owner, null);
    assert.equal(publishing.settled(), false, 'publication waits on the Connection fence');
    await disabler.query('COMMIT');
    await assert.rejects(publishing.result(), fails('M365_CONNECTION_CHANGED'));
  } finally { await disabler.end(); }
  const s = await state(id);
  assert.deepEqual([s.active, s.published], [first.generationId, 1]);
});

test('B1b: a publication holding the fence commits first; the disable waits, then later claims are refused', async () => {
  const { id, tenant } = await fresh();
  const claim = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user');
  await stage(claim, tenant, [guid('1')], () => new Date());
  const disabler = new pg.Client({ connectionString: pgdb.ownerUrl }); await disabler.connect();
  let disabling: ReturnType<typeof inFlight<unknown>> | null = null;
  try {
    await publishDirectoryGeneration(db, syncer, claim, () => new Date(), { beforeCommit: async () => {
      disabling = inFlight(() => disabler.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [id]));
      await waitUntilBlocked(pgdb.owner, null);
    } });
    await disabling!.result();
  } finally { await disabler.end(); }
  assert.equal((await state(id)).active, claim.generationId);
  await assert.rejects(claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user'), fails('CONNECTION_NOT_LIVE'));
});
