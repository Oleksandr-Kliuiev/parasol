import { DATASET_MANIFEST_SHA256 } from './dataset.ts';
import { checkFkDependencies, checkNoLiveEgress, checkNoOtherBackend, checkPolicyQuiescent, checkSingletons, EMPTY_KEYS, MaintenanceRefusal, refuse,
  sameKeys, scopedKeys, setScope } from './inventory.ts';
import type { MaintenanceCode } from './inventory.ts';
import type { Registration } from './materialize.ts';
import type { QueryClient } from './physical.ts';

/**
 * Owner registration of the isolated synthetic sandbox (01 "Local channel and registration", rs-b brief §2 B7): one
 * separate owner transaction with explicit scoped DML on `RevalSandboxRegistration` ONLY (no binding — the first install
 * creates it with its source rows), after the same isolation evidence as a switch: no source row yet, singleton
 * workspace/client/actor, no live connector, no FK dependency, quiescent policy, no other backend. The registration
 * guard keeps the row immutable afterwards. The reader role OID is resolved from the configured role name; the build and
 * dataset digests are the ones the controller later compares.
 */
const sqlRefusal = (e: unknown): MaintenanceCode => {
  const code = (e as { code?: unknown }).code;
  return code === '23505' ? 'ALREADY_REGISTERED' : code === '23503' ? 'REGISTRATION_MISMATCH' : code === '42501' ? 'OWNER_REQUIRED' : 'INTERNAL_FAILURE';
};
export async function registerSandbox(c: QueryClient, r: Registration, ownPids: readonly string[]): Promise<void> {
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query(`SET LOCAL lock_timeout = '5s'`); await c.query(`SET LOCAL statement_timeout = '60s'`);
    await setScope(c, r);
    const fence = (await c.query(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [r.workspaceId])).rows;
    if (fence.length !== 1) refuse('REGISTRATION_MISMATCH');
    await checkPolicyQuiescent(c, r, r.admissionId, true);
    const existing = (await c.query(`SELECT 1 FROM public."RevalSandboxRegistration" WHERE "workspaceId" = $1 OR "registrationId" = $2::uuid
      OR "databaseInstanceId" = $3::uuid`, [r.workspaceId, r.registrationId, r.databaseInstanceId])).rows;
    if (existing.length !== 0) refuse('ALREADY_REGISTERED');
    await checkNoOtherBackend(c, ownPids);
    await checkNoLiveEgress(c);
    await checkSingletons(c, r);
    if (!sameKeys(await scopedKeys(c, r), EMPTY_KEYS())) refuse('EXTRA_ROWS');
    await checkFkDependencies(c, r);
    const member = (await c.query(`SELECT 1 FROM public."ClientMembership" WHERE "workspaceId" = $1 AND "clientId" = $2 AND "actorId" = $3
      AND permissions @> ARRAY['context:read', 'ask:remote']::text[]`, [r.workspaceId, r.clientId, r.actorId])).rows;
    if (member.length !== 1) refuse('UNAUTHORIZED');
    const reader = (await c.query(`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = $1 AND rolcanlogin AND NOT rolsuper`, [r.evidenceReaderRole])).rows;
    if (reader.length !== 1) refuse('REGISTRATION_MISMATCH');
    await c.query(`INSERT INTO public."RevalSandboxRegistration" ("registrationId", "databaseInstanceId", "workspaceId", "clientId", "actorId", "admissionId",
        "evidenceReaderRoleOid", "datasetManifestSha256", "buildManifestSha256", "syntheticOnly")
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::bigint, $8, $9, true)`,
      [r.registrationId, r.databaseInstanceId, r.workspaceId, r.clientId, r.actorId, r.admissionId, reader[0]!.oid, DATASET_MANIFEST_SHA256, r.buildManifestSha256]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MaintenanceRefusal) throw error;
    throw new MaintenanceRefusal(sqlRefusal(error), error);
  }
}
