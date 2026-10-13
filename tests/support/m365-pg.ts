import { PrismaClient } from '@prisma/client';
import type { M365Io } from '../../packages/m365/io.ts';
import { createTestDatabase, runSeed } from './pg-harness.ts';
import type { PgTestDatabase } from './pg-harness.ts';
import { addMappingFixtures } from './graph-fixtures.ts';
import { addM365Actors, addM365Fixtures, M365_CONNECTION } from './m365-fixtures.ts';
import { syntheticSecrets } from './m365-graph-mock.ts';
import type { M365Mock } from './m365-graph-mock.ts';

/**
 * Shared setup of the S2-B PostgreSQL tests: a disposable database through the production path (migrate, roles.sql, seed),
 * the application connected as the confined runtime role, the synthetic M365 fixtures and actors. Mock Graph only.
 */
export async function setupM365Database(): Promise<{ pgdb: PgTestDatabase; db: PrismaClient }> {
  const pgdb = await createTestDatabase();
  const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
  runSeed(pgdb.ownerUrl);
  await addMappingFixtures(pgdb.owner);
  await addM365Fixtures(pgdb.owner);
  await addM365Actors(pgdb.owner);
  return { pgdb, db };
}
export const ioOf = (mock: M365Mock, secrets = syntheticSecrets()): M365Io => ({ graph: mock.graph, tokens: mock.tokens, secrets });

/** A second ACTIVE M365 connection on Gasta (its own tenant), for tests that need an untouched resource/root history. */
export async function addActiveM365Connection(pgdb: PgTestDatabase, id: string, tenant: string): Promise<void> {
  await pgdb.owner.query(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
    VALUES ('demo-vardahei','demo-gasta',$1,'microsoft365',$2,'env://M365_GASTA','ACTIVE','demo-admin',now(),1)`, [id, tenant]);
}
export const connectionRow = async (pgdb: PgTestDatabase, id = M365_CONNECTION) =>
  (await pgdb.owner.query(`SELECT status, "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [id])).rows[0] as { status: string; v: number };
/** Owner-side state of one directory resource (pointer, sequences, status). */
export const directoryState = async (pgdb: PgTestDatabase, resourceType: string, connectionId = M365_CONNECTION) =>
  (await pgdb.owner.query(`SELECT "latestStartedSeq" AS started, "latestRecordedSeq" AS recorded, "latestPublishedSeq" AS published, "activeGenerationId" AS active,
    status, "safeErrorCode" AS code, "lastSuccessAt" AS "lastSuccessAt" FROM "M365ResourceState" WHERE "connectionId" = $1 AND "resourceType" = $2`, [connectionId, resourceType])).rows[0];
