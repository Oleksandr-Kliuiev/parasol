import assert from 'node:assert/strict';
import { rejects } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';

/**
 * Migration 202610081400 (S2-B RC3, approved policy S2B_RETRY_REPAIR_PLAN_RC2): the directory retry budget's CHECK and
 * transition guard, as the owner (triggers apply to every role). Shared by PGlite (tests/m365-database.test.ts) and the
 * real PostgreSQL 17 check (scripts/pg17-check.ts). Uses its own connection; needs seedGraph's workspace/client 'w'/'c1'.
 * Classes: INSERT zero; claim started+1/budget+1 (<8); publication budget 0 with the pointer; reset positive→0, started+1,
 * recorded = started, retryAt NULL, only for exhausted/failed/outstanding chains; nothing else changes started or budget.
 */
const BUDGET_TENANT = '12345678-aaaa-4bbb-8ccc-1234567890ab';
export async function checkM365DirectoryBudget(owner: SqlRunner): Promise<void> {
  await owner.exec(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
    VALUES ('w','c1','mbudget','microsoft365','${BUDGET_TENANT}','env://X','ACTIVE','op',now(),1)`);
  const where = `WHERE "connectionId" = 'mbudget' AND "resourceType" = 'm365_user'`;
  const set = (assignments: string) => owner.exec(`UPDATE "M365ResourceState" SET ${assignments} ${where}`);
  const row = async () => (await owner.query<{ s: number; r: number; u: number; status: string }>(`SELECT "latestStartedSeq" AS s, "latestRecordedSeq" AS r,
    "attemptsUsed" AS u, status FROM "M365ResourceState" ${where}`))[0];
  const insert = (type: string, extra = '') => `INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType"${extra ? ',"attemptsUsed"' : ''})
    VALUES ('w','c1','mbudget','${type}'${extra ? `,${extra}` : ''})`;
  // Domain and INSERT
  await rejects(owner.exec(insert('m365_user', '1')), /unused retry budget/, 'a new state starts at zero');
  await rejects(owner.exec(insert('m365_signin', '1')), /unused retry budget|attempts_check/);
  await owner.exec(insert('m365_user'));
  // Claim class: exactly +1/+1 from below 8; every other started/budget change refused
  await rejects(set(`"latestStartedSeq" = 1`), /retry budget/, 'an uncharged claim');
  await rejects(set(`"attemptsUsed" = 1`), /retry budget/, 'a charge without a claim');
  await rejects(set(`"latestStartedSeq" = 2, "attemptsUsed" = 2`), /retry budget/, 'two claims at once');
  for (let n = 1; n <= 8; n++) await set(`"latestStartedSeq" = ${n}, "attemptsUsed" = ${n}`);
  await rejects(set(`"latestStartedSeq" = 9, "attemptsUsed" = 9`), /retry budget|attempts_check/, 'never a ninth charged claim');
  // A recorded failure (started and budget unchanged) with a retry time is an ordinary outcome
  await set(`"latestRecordedSeq" = 8, status = 'ERROR', "safeErrorCode" = 'M365_UPSTREAM_UNAVAILABLE', "retryAt" = now() + interval '15 minutes'`);
  // Reset: requires a positive budget, started +1, recorded = started, budget 0 and retryAt NULL together
  await rejects(set(`"latestStartedSeq" = 9, "latestRecordedSeq" = 9, "attemptsUsed" = 0`), /retry budget/, 'a reset must clear retryAt');
  await rejects(set(`"latestStartedSeq" = 9, "attemptsUsed" = 0, "retryAt" = NULL`), /retry budget|newest started attempt/, 'recorded must reach the new fence');
  await rejects(set(`"latestStartedSeq" = 10, "latestRecordedSeq" = 10, "attemptsUsed" = 0, "retryAt" = NULL`), /retry budget/, 'one fence step only');
  await set(`"latestStartedSeq" = 9, "latestRecordedSeq" = 9, "attemptsUsed" = 0, "retryAt" = NULL`);
  assert.deepEqual(await row(), { s: 9, r: 9, u: 0, status: 'ERROR' });
  await rejects(set(`"latestStartedSeq" = 10, "latestRecordedSeq" = 10, "retryAt" = NULL`), /retry budget/, 'a zero budget is never reset');
  // A claimed chain after reset; a pointer move must reset the budget (publication class)
  await set(`"latestStartedSeq" = 10, "attemptsUsed" = 1`);
  await owner.exec(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","expiresAt") VALUES ('w','c1','mbudget','m365_user','gb10',10,1,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`);
  const publish = `UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL, "rowCount" = 0 WHERE id = 'gb10'`;
  const point = (budget: string) => `UPDATE "M365ResourceState" SET "activeGenerationId" = 'gb10', "latestPublishedSeq" = 10, "latestRecordedSeq" = 10, status = 'OK',
    "safeErrorCode" = NULL, "lastAttemptAt" = now(), "lastSuccessAt" = now()${budget} ${where}`;
  await rejects(owner.exec(`BEGIN; ${publish}; ${point('')}; COMMIT;`), /resets the retry budget/, 'publication without the budget reset');
  await owner.exec('ROLLBACK').catch(() => undefined);
  await owner.exec(`BEGIN; ${publish}; ${point(', "attemptsUsed" = 0')}; COMMIT;`);
  assert.deepEqual(await row(), { s: 10, r: 10, u: 0, status: 'OK' });
  // Sign-in capability rows never carry a budget
  await owner.exec(insert('m365_signin'));
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 1, "attemptsUsed" = 1 WHERE "connectionId" = 'mbudget' AND "resourceType" = 'm365_signin'`),
    /attempts_check/);
}
