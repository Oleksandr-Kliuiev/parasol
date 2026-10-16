import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { DATASET_MANIFEST_SHA256 } from '../../packages/reval/dataset.ts';
import { ownerScoped } from './ask-remote-pg.ts';
import type { FreshProject } from './ask-remote-pg.ts';

/**
 * Synthetic R-EVAL RS-A fixtures for disposable PostgreSQL databases (test-only; RS-A has no production registration path:
 * RS-B owns `register` and binding population). The table owner writes one registration and its binding inside an owner
 * transaction with app.workspace_id set (FORCE RLS applies to a non-superuser owner as well). Synthetic markers only.
 */
/** RS-C-A: the bridge server reads the registration and requires the frozen dataset manifest (eval-db readRegistration). */
export const DATASET_SHA256 = DATASET_MANIFEST_SHA256;
export const BUILD_SHA256 = createHash('sha256').update('rs-a synthetic build').digest('hex');

export interface Registration { registrationId: string; databaseInstanceId: string; workspaceId: string; clientId: string; actorId: string; admissionId: string }
export interface RegisterOptions { buildManifestSha256?: string; fixtureId?: string; generation?: string; binding?: boolean; registrationId?: string; databaseInstanceId?: string }

/** Inserts the registration (reader OID of `readerRole`) and, unless disabled, its fixture binding. */
export async function registerSandbox(owner: pg.Client, project: FreshProject, readerRole: string, o: RegisterOptions = {}): Promise<Registration> {
  const registrationId = o.registrationId ?? randomUUID(); const databaseInstanceId = o.databaseInstanceId ?? randomUUID();
  await ownerScoped(owner, project.ws, async () => {
    await owner.query(`INSERT INTO "RevalSandboxRegistration" ("registrationId", "databaseInstanceId", "workspaceId", "clientId", "actorId", "admissionId",
        "evidenceReaderRoleOid", "datasetManifestSha256", "buildManifestSha256", "syntheticOnly")
      VALUES ($1, $2, $3, $4, $5, $6, (SELECT oid::bigint FROM pg_roles WHERE rolname = $7), $8, $9, true)`,
      [registrationId, databaseInstanceId, project.ws, project.client, project.actor, project.admissionId, readerRole, DATASET_SHA256,
        o.buildManifestSha256 ?? BUILD_SHA256]);
    if (o.binding !== false) {
      await owner.query(`INSERT INTO "RevalFixtureBinding" ("registrationId", "workspaceId", "clientId", "fixtureId", generation, "syntheticFreshnessAt",
          "datasetManifestSha256") VALUES ($1, $2, $3, $4, $5::bigint, '2026-01-01T00:00:00Z', $6)`,
        [registrationId, project.ws, project.client, o.fixtureId ?? 'FX01', o.generation ?? '1', DATASET_SHA256]);
    }
  });
  return { registrationId, databaseInstanceId, workspaceId: project.ws, clientId: project.client, actorId: project.actor, admissionId: project.admissionId };
}
/** The snapshot routine exactly as the controller calls it (REPEATABLE READ READ ONLY first). Returns the parsed wrapper. */
export async function snapshotAs(reader: pg.Client, isolation = 'REPEATABLE READ READ ONLY'): Promise<Record<string, unknown>> {
  await reader.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  try {
    const w = (await reader.query('SELECT public.atlas_reval_snapshot() AS w')).rows[0].w as Record<string, unknown>;
    await reader.query('COMMIT');
    return w;
  } catch (error) { await reader.query('ROLLBACK').catch(() => undefined); throw error; }
}
export async function connect(url: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }

/** One synthetic attempt for the ledger builder (UTC createdAt; NO_DISPATCH settles to 0, EGRESS keeps its 300000 reserve). */
export interface LedgerRow { createdAt: string; clientId: string; actorId: string; outcome: 'NO_DISPATCH' | 'EGRESS'; priceRevision?: string }
/**
 * Test-only synthetic ledger: written by a SUPERUSER harness client as the confined remote definer (SET ROLE), so every
 * accepted guard CHECK and the deferred ledger invariant still apply at COMMIT. Counters exist for every referenced period
 * and equal the period sums. Never a production path.
 */
export async function syntheticLedger(superuser: pg.Client, remoteRole: string, project: FreshProject, rows: readonly LedgerRow[], priceRevision: string): Promise<void> {
  await superuser.query('BEGIN');
  try {
    await superuser.query(`SET LOCAL ROLE "${remoteRole}"`);
    // Both scope settings: under a NON-superuser table owner the FK checks see "Client" through its client-scoped policy.
    await superuser.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`,
      [project.ws, [...new Set(rows.map(r => r.clientId))].join(',')]);
    const data = JSON.stringify(rows.map(r => ({ ...r, id: randomUUID(), correlationId: randomUUID(), priceRevision: r.priceRevision ?? priceRevision })));
    await superuser.query(`INSERT INTO public."RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", kind, "periodStart")
      SELECT DISTINCT $1, $2, k.kind, k.ps FROM jsonb_to_recordset($3::jsonb) r("createdAt" timestamptz),
        LATERAL (VALUES ('DAY', (r."createdAt" AT TIME ZONE 'UTC')::date), ('MONTH', date_trunc('month', (r."createdAt" AT TIME ZONE 'UTC'))::date)) k(kind, ps)
      ON CONFLICT DO NOTHING`, [project.ws, project.project, data]);
    await superuser.query(`INSERT INTO public."RemoteAskAttempt" ("workspaceId", id, "clientId", "actorId", "admissionId", "projectIdentity", "policyVersion", profile,
        "priceRevision", "correlationId", "dayStart", "monthStart", "reservedMicroUsd", "promptRate", "completionRate", "accountedMicroUsd", state, "createdAt")
      SELECT $1, r.id, r."clientId", r."actorId", $2::uuid, $3, 1, 'ask-remote-openai-luna-v1', r."priceRevision", r."correlationId",
        (r."createdAt" AT TIME ZONE 'UTC')::date, date_trunc('month', (r."createdAt" AT TIME ZONE 'UTC'))::date, 300000, 275, 825, 300000, 'EGRESS_COMMITTED', r."createdAt"
      FROM jsonb_to_recordset($4::jsonb) r(id uuid, "clientId" text, "actorId" text, "priceRevision" text, "correlationId" uuid, "createdAt" timestamptz)`,
      [project.ws, project.admissionId, project.project, data]);
    await superuser.query(`UPDATE public."RemoteAskAttempt" a SET state = 'SETTLED', outcome = 'NO_DISPATCH', "accountedMicroUsd" = 0, "settledAt" = a."createdAt" + interval '1 second'
      FROM jsonb_to_recordset($2::jsonb) r(id uuid, outcome text) WHERE a."workspaceId" = $1 AND a.id = r.id AND r.outcome = 'NO_DISPATCH'`, [project.ws, data]);
    await superuser.query(`UPDATE public."RemoteAskPeriodCounter" c SET "chargedMicroUsd" = (SELECT coalesce(sum(a."accountedMicroUsd"), 0) FROM public."RemoteAskAttempt" a
        WHERE a."workspaceId" = c."workspaceId" AND a."projectIdentity" = c."projectIdentity"
          AND CASE c.kind WHEN 'DAY' THEN a."dayStart" = c."periodStart" ELSE a."monthStart" = c."periodStart" END)
      WHERE c."workspaceId" = $1 AND c."projectIdentity" = $2`, [project.ws, project.project]);
    await superuser.query('COMMIT');
  } catch (error) { await superuser.query('ROLLBACK').catch(() => undefined); throw error; }
}
