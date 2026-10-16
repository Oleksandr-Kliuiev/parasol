import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stateFile } from './runtime.mjs';
import { assertPrivateState, sourceKey, fixturePlan, ROLES, WORKSPACE } from './plan.mjs';
import { atlasRequire, sql, privileges, verifyContainer } from './database.mjs';

export const OPERATIONS = ['revokeTechnicianMembership', 'restoreTechnicianMembership',
  'revokeTechnicianToken', 'restoreTechnicianToken', 'countsTaskEvidence'];
const literal = value => `N'${value.replaceAll("'", "''")}'`;

async function taskEvidence(state, pg) {
  const { target } = fixturePlan(); const key = sourceKey(target.atlasClientId, target.observationIdOutsideFirst100);
  const forbidden = [target.observationSummaryOutsideFirst100, target.observationIdOutsideFirst100,
    target.duplicateHostname, target.confirmedDeviceId, 'Synthetic source details never copied to CRM'];
  const absent = column => forbidden.map(value => `CHARINDEX(${literal(value)},COALESCE(${column},N''))=0`).join(' AND ');
  const raw = await sql(state, `DECLARE @id uniqueidentifier=(SELECT ActivityId FROM activities.SourceTaskLinks WHERE SourceKey='${key}');
    SELECT (SELECT COUNT(*) FROM activities.Activities WHERE Id=@id AND Type='Task') taskCount,
      (SELECT COUNT(*) FROM activities.SourceTaskLinks WHERE SourceKey='${key}') receiptCount,
      (SELECT COUNT(*) FROM audit.AuditEntries WHERE EntityId=@id AND Module='activities' AND EntityType='Activity' AND Action='Create') createAuditCount,
      (SELECT COUNT(*) FROM activities.OutboxMessages WHERE Type LIKE 'Crm.Activities.Contracts.ActivityLogged,%' AND JSON_VALUE(Payload,'$.activityId')=CONVERT(nvarchar(36),@id)) totalActivityLoggedCount,
      CAST(CASE WHEN NOT EXISTS(SELECT 1 FROM activities.Activities WHERE Id=@id AND Body IS NOT NULL) THEN 1 ELSE 0 END AS bit) bodyIsNull,
      CAST(CASE WHEN NOT EXISTS(SELECT 1 FROM activities.Activities WHERE Id=@id AND Subject<>N'Review technical observation') THEN 1 ELSE 0 END AS bit) genericSubject,
      CAST(CASE WHEN NOT EXISTS(SELECT 1 FROM activities.Activities WHERE Id=@id AND NOT (${absent("Subject+COALESCE(Body,N'')")})) THEN 1 ELSE 0 END AS bit) sourceTextAbsentFromTask,
      CAST(CASE WHEN NOT EXISTS(SELECT 1 FROM audit.AuditEntries WHERE EntityId=@id AND NOT (${absent('Changes')})) THEN 1 ELSE 0 END AS bit) sourceTextAbsentFromAudit
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
  const facts = JSON.parse(raw.trim());
  const actual = (await pg.query(`SELECT
    (SELECT count(*)::int FROM "Client" WHERE "workspaceId"=$1) clients,
    (SELECT count(*)::int FROM "Device" WHERE "workspaceId"=$1) devices,
    (SELECT count(*)::int FROM "Actor" WHERE "workspaceId"=$1) employees`, [WORKSPACE])).rows[0];
  const access = JSON.parse(await readFile(join(state.directory, 'private/atlas-access.json'), 'utf8'));
  return { ...facts, providerWrites: access.providerWrites, atlasRequests: access.requests, actualScale: actual, privileges: await privileges(state) };
}

export async function executeControl(path, operation) {
  if (!OPERATIONS.includes(operation)) throw new Error('Unsupported owner fixture control.');
  const state = await stateFile(path); assertPrivateState(state);
  if (state.root !== fileURLToPath(new URL('../../', import.meta.url)) || resolve(path) !== join(state.directory, 'private/state.json')
    || state.phase !== 'ready') throw new Error('An owned ready fixture is required.');
  // Verify both endpoints before any owner read/write: a copied or edited state cannot target another local database.
  await verifyContainer(state, state.sqlContainer); await verifyContainer(state, state.pgContainer);
  const { Client } = atlasRequire(state.root)('pg'); const pg = new Client({ connectionString: state.atlasOwnerUrl, connectionTimeoutMillis: 5000 });
  await pg.connect();
  try {
    if (operation === 'countsTaskEvidence') return await taskEvidence(state, pg);
    const technician = state.employees.find(employee => employee.role === ROLES[1]);
    if (!technician || !/^composition-actor-2$/.test(technician.actorId) || !/^composition-token-2$/.test(technician.tokenId))
      throw new Error('The synthetic technician identity is invalid.');
    const clientId = fixturePlan().target.atlasClientId;
    if (operation === 'revokeTechnicianMembership') await pg.query('DELETE FROM "ClientMembership" WHERE "workspaceId"=$1 AND "clientId"=$2 AND "actorId"=$3', [WORKSPACE, clientId, technician.actorId]);
    else if (operation === 'restoreTechnicianMembership') await pg.query('INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4) ON CONFLICT ("workspaceId","clientId","actorId") DO UPDATE SET permissions=EXCLUDED.permissions', [WORKSPACE, clientId, technician.actorId, ['context:read']]);
    else await pg.query('UPDATE "ApiToken" SET "revokedAt"=' + (operation === 'revokeTechnicianToken' ? 'clock_timestamp()' : 'NULL') + ' WHERE "workspaceId"=$1 AND id=$2 AND "actorId"=$3', [WORKSPACE, technician.tokenId, technician.actorId]);
    return { operation, applied: true };
  } finally { await pg.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--state' || args[2] !== '--operation') throw new Error('Invalid owner control arguments.');
    console.log(JSON.stringify(await executeControl(args[1], args[3])));
  } catch { console.error('COMPOSITION_CONTROL_FAILED: the confined synthetic owner operation was refused or failed.'); process.exitCode = 1; }
}
