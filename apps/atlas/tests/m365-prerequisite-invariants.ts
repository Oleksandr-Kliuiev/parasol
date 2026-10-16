import assert from 'node:assert/strict';
import { rejects } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';
import { guid, seedM365 } from './m365-sql-invariants.ts';

/**
 * Lifecycle entry checks (review S2-A-rc3), shared by PGlite and real PostgreSQL. A child row is accepted only in its
 * permitted initial state and only when every prerequisite row is already visible and in the required state; nothing is
 * left to a later foreign-key check. A parent inserted by the SAME statement (a data-modifying CTE) is not visible to the
 * child's trigger and is therefore refused, while ordered parent-first creation in one transaction works. Owner session
 * after seedGraph (the triggers apply to every role). Synthetic data only.
 */
const STATE = (seq = 1) => `INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq")
  VALUES ('w','c1','m1','m365_user',${seq}) RETURNING 1`;
const GEN = (state = 'STAGING', extra = '') => `INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq",
  "lifecycleVersion","state","claimToken","leaseExpiresAt","expiresAt"${extra ? ',"completedAt"' : ''}) VALUES ('w','c1','m1','m365_user','pg-1',1,1,'${state}',
  ${state === 'STAGING' ? `gen_random_uuid(),now() + interval '10 minutes'` : 'NULL,NULL'},now() + interval '23 hours'${extra}) RETURNING 1`;
const OBJ = `INSERT INTO "M365DirectoryObject" VALUES ('w','c1','m1','m365_user','pg-1','${guid('a')}',NULL,NULL,
  '{"id":"${guid('a')}","displayName":null,"userPrincipalName":null,"userType":null,"accountEnabled":null}')`;
const R = `date_trunc('hour', now()) - interval '2 hours'`;
const WIN = `INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId","id","rootFrom","rootTo","latestStartedSeq")
  VALUES ('w','c1','m1','pw',${R},${R} + interval '1 hour',1) RETURNING 1`;
const REQ = `INSERT INTO "M365SyncRequest" ("workspaceId","clientId","connectionId","id","requestedFrom","requestedTo","configVersion","rootCount","createdBy")
  VALUES ('w','c1','m1','preq',${R},${R} + interval '1 hour','m365-sync.1',1,'m365-op');
  INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts") VALUES ('w','c1','m1','preq','pw',5)`;
const ATT = (state = 'RUNNING') => `INSERT INTO "M365WindowAttempt" ("workspaceId","clientId","connectionId","windowId","id","rootFrom","requestId","attemptSeq",
  "lifecycleVersion","coveredFrom","coveredTo","configVersion","claimToken","leaseExpiresAt","deadlineAt","state","completedAt","publishedAt","expiresAt")
  VALUES ('w','c1','m1','pw','pa',${R},'preq',1,1,${R},${R} + interval '1 hour','m365-sync.1',
  ${state === 'RUNNING' ? `gen_random_uuid(),now() + interval '10 minutes'` : 'NULL,NULL'},now() + interval '10 minutes','${state}',
  ${state === 'RUNNING' ? 'NULL,NULL' : 'now(),now()'},now() + interval '1 hour') RETURNING 1`;
const LEAF = (state = 'PENDING') => `INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","fromInclusive","toExclusive","state")
  VALUES ('w','c1','m1','pw','pa','L0',${R},${R} + interval '1 hour','${state}')`;
const EV = `INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","expiresAt") VALUES
  ('w','c1','m1','pev','pev','${'f'.repeat(64)}','{"id":"pev","createdDateTime":"2026-10-08T08:05:00Z","userId":null,"deviceId":null,"appId":null,"errorCode":null,"isInteractive":null}',
  ${R} + interval '5 minutes',${R} + interval '5 minutes' + interval '7 days') RETURNING 1`;
const MEMBER = `INSERT INTO "M365WindowEvidence" VALUES ('w','c1','m1','pw','pa','L0','pev')`;
const count = async (o: SqlRunner, table: string) => Number((await o.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))[0]?.n ?? 0);
const cte = (parent: string, child: string) => `WITH parent AS (${parent}) ${child}`;

export async function checkM365Prerequisites(owner: SqlRunner): Promise<void> {
  await seedM365(owner);
  // Directory: the initial state is checked independently of the parent lookup
  await rejects(owner.exec(GEN('PUBLISHED', `,now()`)), /starts STAGING/, 'never created terminal, even without a state row');
  await rejects(owner.exec(GEN()), /needs its resource state to exist first/);
  await rejects(owner.exec(cte(STATE(), GEN('PUBLISHED', `,now()`))), /starts STAGING/, 'same statement, terminal');
  await rejects(owner.exec(cte(STATE(), GEN())), /needs its resource state to exist first/, 'same statement: the parent is not yet visible');
  await rejects(owner.exec(OBJ), /needs its STAGING generation to exist first/);
  // A refused child rolls back the whole transaction, parent included
  await rejects(owner.exec(`BEGIN; ${STATE()}; ${OBJ}; COMMIT;`), /needs its STAGING generation/);
  await owner.exec('ROLLBACK').catch(() => undefined);
  assert.deepEqual([await count(owner, 'M365ResourceState'), await count(owner, 'M365DirectoryGeneration'), await count(owner, 'M365DirectoryObject')], [0, 0, 0]);
  // Ordered parent-first creation in one transaction is the supported path
  await owner.exec(`BEGIN; ${STATE()}; ${GEN()}; ${OBJ}; COMMIT;`);
  await rejects(owner.exec(GEN('PUBLISHED', `,now()`).replace("'pg-1',1", "'pg-2',1")), /starts STAGING/, 'with the state present, still never terminal');
  assert.deepEqual([await count(owner, 'M365DirectoryGeneration'), await count(owner, 'M365DirectoryObject')], [1, 1]);

  // Sign-in: attempt → window, leaf → attempt, membership → attempt, leaf and evidence
  await rejects(owner.exec(ATT('COMPLETE')), /starts RUNNING/, 'never created complete, even without a window');
  await rejects(owner.exec(ATT()), /needs its window to exist first/);
  await rejects(owner.exec(cte(WIN, ATT())), /needs its window to exist first/, 'same statement: the window is not yet visible');
  await rejects(owner.exec(LEAF()), /needs its RUNNING attempt to exist first/);
  await rejects(owner.exec(LEAF('RUNNING')), /starts PENDING/, 'the initial leaf state is checked first');
  await rejects(owner.exec(MEMBER), /needs its RUNNING attempt to exist first/);
  await owner.exec(`BEGIN; ${WIN}; ${REQ}; ${ATT()}; COMMIT;`);
  await rejects(owner.exec(ATT('COMPLETE').replace("'pa'", "'pa2'")), /starts RUNNING/, 'with the window present, still never complete');
  await rejects(owner.exec(MEMBER), /needs its RUNNING leaf to exist first/);
  await owner.exec(LEAF());
  await owner.exec(`UPDATE "M365WindowLeaf" SET state = 'RUNNING' WHERE "attemptId" = 'pa'`);
  await rejects(owner.exec(MEMBER), /needs its evidence version to exist first/);
  await rejects(owner.exec(cte(EV, MEMBER)), /needs its evidence version to exist first/, 'same statement: the evidence is not yet visible');
  assert.equal(await count(owner, 'M365SignInEvidence'), 0, 'the refused statement inserted nothing');
  await owner.exec(`BEGIN; ${EV}; ${MEMBER}; COMMIT;`);
  assert.equal(await count(owner, 'M365WindowEvidence'), 1);

  // ExternalEntity system match runs after the statement (AFTER ROW): a same-statement connection is seen and checked
  await rejects(owner.exec(cte(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status")
    VALUES ('w','c1','m-cte','microsoft365','${guid('9')}','env://X','DISABLED') RETURNING 1`,
    `INSERT INTO "ExternalEntity" VALUES ('w','c1','x-cte','m-cte','agent','agent-cte','{}',now())`)), /does not belong to its connection system/);
}
