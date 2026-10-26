import { join } from 'node:path';
import { command, safeEnvironment } from './runtime.mjs';
import { CONTAINER_LABEL, assertOwnedContainerLabel, assertOwnedContainerNetwork } from './plan.mjs';

export async function docker(args, options = {}) {
  return command('docker', args, { label: 'Owned database operation', ...options });
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
  for (const [login, password, role] of [['harness_web', state.sqlWebPassword, 'crm_web'], ['harness_worker', state.sqlWorkerPassword, 'crm_worker']]) {
    if (!/^[A-Za-z0-9!]{32,128}$/.test(password)) throw new Error('Invalid generated test password.');
    await sql(state, `CREATE LOGIN [${login}] WITH PASSWORD=N'${password}';`, 'master');
    await sql(state, `CREATE USER [${login}] FOR LOGIN [${login}]; ALTER ROLE [${role}] ADD MEMBER [${login}];`);
  }
}
export async function removeOwnedContainer(state, name) {
  assertOwnedContainerLabel(state, name, state.runId);
  const exists = async () => (await docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { timeout: 10_000 })).trim();
  if (!await exists()) return; // A successful inventory is the only accepted proof of absence.
  const [info] = JSON.parse(await docker(['inspect', name], { timeout: 10_000 }));
  assertOwnedContainerLabel(state, name, info?.Config?.Labels?.[CONTAINER_LABEL]);
  if (!/^[a-f0-9]{64}$/.test(info.Id)) throw new Error('An immutable owned container ID is required.');
  await docker(['rm', '--force', '--volumes', info.Id], { timeout: 30_000 });
  if (await exists()) throw new Error('Owned database container removal was not confirmed.');
}
