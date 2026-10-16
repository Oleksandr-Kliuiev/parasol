import pg from 'pg';
import { DATASET_MANIFEST_SHA256, SYNTHETIC_FRESHNESS_AT } from './dataset.ts';
import type { FrozenDataset } from './dataset.ts';
import { checkFkDependencies, checkNoLiveEgress, checkPolicyQuiescent, checkRegisteredIdle, checkSingletons, EMPTY_KEYS, MaintenanceRefusal,
  preservedFingerprint, refuse, sameKeys, scopedKeys, setScope } from './inventory.ts';
import type { MaintenanceCode, RegisteredRoles, Scope } from './inventory.ts';
import type { QueryClient } from './physical.ts';
import { JSON_COLUMNS, planKeys, SeedPlanError, seedPlan, SOURCE_TABLES } from './seed-plan.ts';
import type { Row, SeedMapping, SeedPlan, SourceTable } from './seed-plan.ts';

/**
 * The fence-first fixture switch (03 "Transaction and switch procedure", rs-b brief §2 B6) on ONE owner connection whose
 * physical binding and registration were already confirmed (plus a second independent connection, maintain-cli.ts). In one
 * READ COMMITTED transaction: fence FOR UPDATE → policy FOR UPDATE → binding FOR UPDATE; registration, generation,
 * quiescence and the exact inventory; source rows FOR UPDATE in fixed table/key order; DELETE the previous allowlisted
 * state (proven equal to the previous plan); INSERT the new plan; binding generation + 1; COMMIT. The Connection fence
 * triggers keep their increments. No TRUNCATE, DDL, trigger/RLS/role change; finance/audit/history fingerprint is compared
 * before and after. A read-only pass after COMMIT re-checks rows = plan.
 */
export interface Registration extends Scope {
  readonly registrationId: string; readonly databaseInstanceId: string; readonly admissionId: string;
  readonly evidenceReaderRole: string; readonly buildManifestSha256: string;
}
export interface InstallResult { readonly fixtureId: string; readonly generation: string; readonly seedMappingSha256: string; readonly fenceAdvanced: boolean }
/** Test-only seam: runs inside the switch transaction after the INSERTs, before the binding update (rollback probes). */
export interface SwitchHooks { readonly afterInsert?: (c: QueryClient) => Promise<void> }

const quote = (n: string) => pg.escapeIdentifier(n);
/** Reads the registration under FORCE RLS (workspace set) and requires every immutable column to match the owner config. */
export async function checkRegistration(c: QueryClient, r: Registration): Promise<void> {
  const rows = (await c.query(`SELECT "registrationId"::text AS id, "databaseInstanceId"::text AS dbi, "workspaceId" AS ws, "clientId" AS cl,
      "actorId" AS ac, "admissionId"::text AS adm, "evidenceReaderRoleOid"::text AS oid, "datasetManifestSha256" AS ds,
      "buildManifestSha256" AS build, "syntheticOnly" AS syn,
      (SELECT g.oid::text FROM pg_catalog.pg_roles g WHERE g.rolname = $2) AS reader
    FROM public."RevalSandboxRegistration" WHERE "workspaceId" = $1`, [r.workspaceId, r.evidenceReaderRole])).rows;
  if (rows.length === 0) refuse('UNREGISTERED');
  const x = rows[0]!;
  if (rows.length !== 1 || x.id !== r.registrationId || x.dbi !== r.databaseInstanceId || x.cl !== r.clientId || x.ac !== r.actorId
    || x.adm !== r.admissionId || x.oid !== x.reader || x.ds !== DATASET_MANIFEST_SHA256 || x.build !== r.buildManifestSha256 || x.syn !== true) {
    refuse('REGISTRATION_MISMATCH');
  }
}
function insertSql(table: SourceTable, row: Row): { text: string; values: unknown[] } {
  const cols = Object.keys(row);
  const json = JSON_COLUMNS[table] ?? [];
  const values = cols.map(k => (json.includes(k) ? JSON.stringify(row[k]) : row[k]));
  return { text: `INSERT INTO public.${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values };
}
const sqlRefusal = (e: unknown): MaintenanceCode => {
  const code = (e as { code?: unknown }).code;
  return code === '23503' ? 'FK_DEPENDENCY' : code === '55P03' || code === '57014' ? 'DEADLINE' : code === '42501' ? 'OWNER_REQUIRED' : 'INTERNAL_FAILURE';
};

/**
 * Installs `fixtureId` when the current binding generation equals `expectedGeneration` ("0" = no binding yet). `ownPids` are
 * this tool's own backends (both connections); RS-D-A (D2): besides them the census admits only the registered S/C sessions of
 * `roles` while idle (inventory.ts checkRegisteredIdle), so S and C stay up through a switch.
 */
export async function installFixture(c: QueryClient, r: Registration, dataset: FrozenDataset, mapping: { mapping: SeedMapping; sha256: string },
  fixtureId: string, expectedGeneration: string, ownPids: readonly string[], roles: RegisteredRoles, hooks: SwitchHooks = {}): Promise<InstallResult> {
  let plan: SeedPlan;
  try { plan = seedPlan(dataset, fixtureId, mapping.mapping, mapping.sha256); } catch (e) { if (e instanceof SeedPlanError) refuse('PLAN_INVALID'); throw e; }
  if (dataset.file.scope.workspaceId !== r.workspaceId || dataset.file.scope.clientId !== r.clientId) refuse('REGISTRATION_MISMATCH');
  let before = '';
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query(`SET LOCAL lock_timeout = '5s'`); await c.query(`SET LOCAL statement_timeout = '60s'`);
    await setScope(c, r);
    await checkRegistration(c, r);
    // Fence FIRST, then policy, then binding (03 step 2).
    const fence = (await c.query(`SELECT version::text AS v FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [r.workspaceId])).rows;
    if (fence.length !== 1) refuse('REGISTRATION_MISMATCH');
    await checkPolicyQuiescent(c, r, r.admissionId, true);
    const binding = (await c.query(`SELECT "fixtureId" AS f, generation::text AS g, "datasetManifestSha256" AS ds
      FROM public."RevalFixtureBinding" WHERE "registrationId" = $1::uuid FOR UPDATE`, [r.registrationId])).rows;
    const current = binding.length === 1 ? binding[0]! : null;
    if ((current?.g ?? '0') !== expectedGeneration) refuse('GENERATION_MISMATCH');
    if (current && current.ds !== DATASET_MANIFEST_SHA256) refuse('REGISTRATION_MISMATCH');
    await checkRegisteredIdle(c, ownPids, roles);
    await checkNoLiveEgress(c);
    await checkSingletons(c, r);
    // The scoped source state must be exactly the previous plan (or nothing before the first install): no extra/foreign row.
    let previous = EMPTY_KEYS();
    if (current) {
      try { previous = planKeys(seedPlan(dataset, current.f as string, mapping.mapping, mapping.sha256)); }
      catch (e) { if (e instanceof SeedPlanError) refuse('PLAN_INVALID'); throw e; }
    }
    for (const t of [...SOURCE_TABLES].reverse()) {
      await c.query(`SELECT 1 FROM public.${quote(t.table)} WHERE "workspaceId" = $1 AND "clientId" = $2 ORDER BY ${t.key.map(quote).join(', ')} FOR UPDATE`,
        [r.workspaceId, r.clientId]);
    }
    if (!sameKeys(await scopedKeys(c, r), previous)) refuse('EXTRA_ROWS');
    await checkFkDependencies(c, r);
    before = await preservedFingerprint(c);
    for (const t of [...SOURCE_TABLES].reverse()) await c.query(`DELETE FROM public.${quote(t.table)} WHERE "workspaceId" = $1 AND "clientId" = $2`, [r.workspaceId, r.clientId]);
    for (const t of SOURCE_TABLES) for (const row of plan.rows[t.table]) { const q = insertSql(t.table, row); await c.query(q.text, q.values); }
    if (hooks.afterInsert) await hooks.afterInsert(c);
    const next = current ? String(BigInt(current.g as string) + 1n) : '1';
    if (current) {
      const u = await c.query(`UPDATE public."RevalFixtureBinding" SET "fixtureId" = $2, generation = $3::bigint, "syntheticFreshnessAt" = $4::timestamptz,
        "datasetManifestSha256" = $5 WHERE "registrationId" = $1::uuid AND generation = $6::bigint RETURNING generation::text AS g`,
        [r.registrationId, fixtureId, next, SYNTHETIC_FRESHNESS_AT, DATASET_MANIFEST_SHA256, expectedGeneration]);
      if (u.rows.length !== 1 || u.rows[0]!.g !== next) refuse('GENERATION_MISMATCH');
    } else {
      await c.query(`INSERT INTO public."RevalFixtureBinding" ("registrationId", "workspaceId", "clientId", "fixtureId", generation, "syntheticFreshnessAt",
        "datasetManifestSha256") VALUES ($1::uuid, $2, $3, $4, 1, $5::timestamptz, $6)`,
        [r.registrationId, r.workspaceId, r.clientId, fixtureId, SYNTHETIC_FRESHNESS_AT, DATASET_MANIFEST_SHA256]);
    }
    if (!sameKeys(await scopedKeys(c, r), planKeys(plan)) || await preservedFingerprint(c) !== before) refuse('INTERNAL_FAILURE');
    const fenceAfter = (await c.query(`SELECT version::text AS v FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1`, [r.workspaceId])).rows[0]!.v as string;
    await c.query('COMMIT');
    return { fixtureId, generation: next, seedMappingSha256: mapping.sha256, fenceAdvanced: BigInt(fenceAfter) > BigInt(fence[0]!.v as string) };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MaintenanceRefusal) throw error;
    throw new MaintenanceRefusal(sqlRefusal(error), error);
  }
}

/** Read-only pass after COMMIT: binding generation/fixture/reference and rows = plan; finance/audit fingerprint unchanged. */
export async function postCheck(c: QueryClient, r: Registration, plan: SeedPlan, generation: string): Promise<boolean> {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await setScope(c, r);
    const b = (await c.query(`SELECT "fixtureId" AS f, generation::text AS g, "syntheticFreshnessAt" = $2::timestamptz AS ref, "datasetManifestSha256" AS ds
      FROM public."RevalFixtureBinding" WHERE "registrationId" = $1::uuid`, [r.registrationId, SYNTHETIC_FRESHNESS_AT])).rows;
    const ok = b.length === 1 && b[0]!.f === plan.fixtureId && b[0]!.g === generation && b[0]!.ref === true && b[0]!.ds === DATASET_MANIFEST_SHA256
      && sameKeys(await scopedKeys(c, r), planKeys(plan));
    await c.query('COMMIT');
    return ok;
  } catch { await c.query('ROLLBACK').catch(() => undefined); return false; }
}
export { preservedFingerprint };
