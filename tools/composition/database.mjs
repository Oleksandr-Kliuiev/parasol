import { writeFile, chmod, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { command, pause, safeEnvironment, jsonFile } from './runtime.mjs';
import { SQL_IMAGE, PG_IMAGE, assertOwnedContainerLabel, assertOwnedContainerNetwork } from './plan.mjs';

export const atlasRequire = root => createRequire(join(root, 'apps/atlas/package.json'));
export async function docker(args, options = {}) {
  return command('docker', args, { label: 'Owned database operation', ...options });
}
export function readinessErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNCLASSIFIED';
}
export function sqlReadinessLabel(error) {
  if (/^Owned database operation failed \((?:\d+|SIG[A-Z]+)\); inspect its redacted stage log\.$/.test(error?.message ?? ''))
    return 'SQL_COMMAND_FAILED';
  if (/^(An owned database container|An immutable owned container ID|Refusing a database endpoint|Refusing a foreign database container)/.test(error?.message ?? ''))
    return 'SQL_CONTAINER_GUARD_FAILED';
  return 'SQL_PROBE_FAILED';
}
export async function startDatabases(state, options) {
  for (const image of [options.sqlImage ?? SQL_IMAGE, options.pgImage ?? PG_IMAGE])
    await docker(['image', 'inspect', image], { timeout: 10_000 }); // cached only; no implicit pulls.
  const sqlSecret = join(state.directory, 'private/sql-password'); const pgSecret = join(state.directory, 'private/pg-password');
  await writeFile(sqlSecret, state.sqlSaPassword, { mode: 0o600 }); await writeFile(pgSecret, state.pgPassword, { mode: 0o600 });
  // Container UIDs must read these mounts; the host parent remains0700 and mount is read-only (same pattern as VPS tooling).
  await chmod(sqlSecret, 0o444); await chmod(pgSecret, 0o444);
  const labels = ['--label', `parasol.composition.run=${state.runId}`];
  await docker(['run', '--detach', '--pull=never', '--name', state.sqlContainer, ...labels, '--platform', 'linux/amd64',
    '--publish', `127.0.0.1:${state.ports.sql}:1433`, '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_PID=Express', '--env', 'MSSQL_MEMORY_LIMIT_MB=2048',
    '--mount', `type=bind,src=${sqlSecret},dst=/run/secrets/sql-sa-password,readonly`,
    '--mount', `type=bind,src=${join(state.root, 'deploy/hostinger/sql-entrypoint.sh')},dst=/opt/parasol/sql-entrypoint.sh,readonly`,
    '--entrypoint', '/bin/sh', options.sqlImage ?? SQL_IMAGE, '/opt/parasol/sql-entrypoint.sh']);
  await docker(['run', '--detach', '--pull=never', '--name', state.pgContainer, ...labels,
    '--publish', `127.0.0.1:${state.ports.pg}:5432`, '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg-password',
    '--mount', `type=bind,src=${pgSecret},dst=/run/secrets/pg-password,readonly`, options.pgImage ?? PG_IMAGE]);
  const { Client } = atlasRequire(state.root)('pg');
  const deadline = Date.now() + 180_000; let sqlReady = false; let pgReady = false;
  let lastPGErrorCode = null; let lastSQLLabel = null;
  try {
    while (Date.now() < deadline && (!sqlReady || !pgReady)) {
      options.signal?.throwIfAborted();
      if (!sqlReady) try { await sql(state, 'SELECT 1;', 'master'); sqlReady = true; }
      catch (error) { lastSQLLabel = sqlReadinessLabel(error); }
      if (!pgReady) {
        const client = new Client({ connectionString: state.pgAdminUrl, connectionTimeoutMillis: 1500 });
        try { await client.connect(); await client.query('SELECT 1'); pgReady = true; }
        catch (error) { lastPGErrorCode = readinessErrorCode(error); }
        finally { await client.end().catch(() => {}); }
      }
      if (!sqlReady || !pgReady) await pause(500);
    }
  } finally {
    // Compact synthetic facts survive credential cleanup. Never retain error messages, URLs or database rows.
    await jsonFile(join(state.directory, 'logs/database-readiness.json'), { sqlReady, pgReady, lastPGErrorCode, lastSQLLabel });
  }
  if (!sqlReady || !pgReady) throw new Error('Owned PostgreSQL/SQL Server readiness failed.');
}

export async function sql(state, query, database = state.sqlDatabase) {
  if (database !== 'master' && database !== state.sqlDatabase) throw new Error('Refusing a non-fixture SQL database.');
  const containerId = await verifyContainer(state, state.sqlContainer);
  return docker(['exec', '--interactive', '--env', 'SQLCMDPASSWORD', containerId, '/opt/mssql-tools18/bin/sqlcmd',
    // ODBC sqlcmd forbids header suppression with unlimited (-y 0) columns; keep JSON wide but bounded instead.
    '-C', '-S', 'localhost', '-U', 'sa', '-d', database, '-b', '-h', '-1', '-y', '8000', '-w', '65535'],
  { env: safeEnvironment({ SQLCMDPASSWORD: state.sqlSaPassword }), input: 'SET NOCOUNT ON;\n' + query + '\nGO\n',
    logPath: join(state.directory, 'logs/sql-last.log'), timeout: 60_000,
    secrets: [state.sqlSaPassword, state.sqlWebPassword, state.sqlWorkerPassword] });
}
export async function verifyContainer(state, name) {
  const info = JSON.parse(await docker(['inspect', name], { timeout: 10_000 }));
  if (!Array.isArray(info) || info.length !== 1) throw new Error('An owned database container is required.');
  assertOwnedContainerNetwork(state, name, info[0]);
  if (!/^[a-f0-9]{64}$/.test(info[0].Id)) throw new Error('An immutable owned container ID is required.');
  return info[0].Id;
}
export async function prepareSqlLogins(state) {
  for (const [login, password, role] of [['composition_web', state.sqlWebPassword, 'crm_web'], ['composition_worker', state.sqlWorkerPassword, 'crm_worker']]) {
    if (!/^[A-Za-z0-9!]{32,128}$/.test(password)) throw new Error('Invalid generated test password.');
    await sql(state, `CREATE LOGIN [${login}] WITH PASSWORD=N'${password}';`, 'master');
    await sql(state, `CREATE USER [${login}] FOR LOGIN [${login}]; ALTER ROLE [${role}] ADD MEMBER [${login}];`);
  }
}
export async function prepareAtlasDatabase(state, signal) {
  // The unchanged production-path test harness invokes Prisma synchronously. Bound that whole owned process group.
  await command(process.execPath, ['--experimental-strip-types', join(state.root, 'tools/composition/prepare-atlas.mjs')], {
    env: safeEnvironment({ PARASOL_COMPOSITION_STATE: join(state.directory, 'private/state.json') }),
    label: 'Atlas migrations and production role grants', timeout: 180_000, signal,
  });
  const result = JSON.parse(await readFile(join(state.directory, 'private/atlas-database.json'), 'utf8'));
  state.atlasOwnerUrl = result.ownerUrl; state.atlasRuntimeUrl = result.runtimeUrl; state.atlasRoles = result.roles;
  const { Client } = atlasRequire(state.root)('pg'); const owner = new Client({ connectionString: state.atlasOwnerUrl });
  await owner.connect();
  return { owner, async drop() { await owner.end(); } }; // The fresh cluster and every role are removed with its verified container.
}
export async function privileges(state) {
  const sqlFlags = {};
  for (const [alias, login, role] of [['crmWebRestricted', 'composition_web', 'crm_web'], ['crmWorkerRestricted', 'composition_worker', 'crm_worker']]) {
    const value = await sql(state, `EXECUTE AS LOGIN='${login}'; SELECT CASE WHEN IS_SRVROLEMEMBER('sysadmin')=0 AND IS_ROLEMEMBER('db_owner')=0
      AND IS_ROLEMEMBER('${role}')=1 AND HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER')=0 THEN 1 ELSE 0 END; REVERT;`);
    sqlFlags[alias] = value.trim() === '1';
  }
  const { Client } = atlasRequire(state.root)('pg'); const pg = new Client({ connectionString: state.atlasRuntimeUrl });
  await pg.connect();
  try {
    const facts = (await pg.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolcanlogin,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=pg_roles.oid) member,
      EXISTS(SELECT 1 FROM pg_class c WHERE c.relowner=pg_roles.oid AND c.relnamespace='public'::regnamespace) owns
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    return { ...sqlFlags, atlasRuntimeRestricted: !!facts && facts.rolname === state.atlasRoles.runtime
      && !facts.rolsuper && !facts.rolbypassrls && !facts.rolcreatedb && !facts.rolcreaterole && facts.rolcanlogin && !facts.member && !facts.owns };
  } finally { await pg.end(); }
}
export async function removeOwnedContainer(state, name) {
  assertOwnedContainerLabel(state, name, state.runId);
  const exists = async () => (await docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { timeout: 10_000 })).trim();
  if (!await exists()) return; // A successful inventory is the only accepted proof of absence.
  const [info] = JSON.parse(await docker(['inspect', name], { timeout: 10_000 }));
  assertOwnedContainerLabel(state, name, info?.Config?.Labels?.['parasol.composition.run']);
  if (!/^[a-f0-9]{64}$/.test(info.Id)) throw new Error('An immutable owned container ID is required.');
  await docker(['rm', '--force', '--volumes', info.Id], { timeout: 30_000 });
  if (await exists()) throw new Error('Owned database container removal was not confirmed.');
}
