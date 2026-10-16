import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import pg from 'pg';
import { APPLICATION_NAME } from './codes.ts';
import { loadOwnerConfig } from './config.ts';
import type { OwnerConfig } from './config.ts';
import { loadFrozenDataset } from './dataset.ts';
import { computeDigests, PROJECT_ROOT } from './launch.ts';
import type { MaintainDeps } from './maintain-cli.ts';
import { connectFailure, destroyClient, nodePhysicalDeps, PHYSICAL_QUERY, PhysicalMismatchError, verifyPhysicalEndpoint } from './physical.ts';
import type { QueryClient } from './physical.ts';
import type { PhysicalTuple } from './private-frames.ts';
import { readSecretFile } from './secret-file.ts';

/**
 * The ONLY dependency set of the production maintenance entry (scripts/reval-server/maintain.ts): unix-socket physical
 * binding of both owner connections (the RS-A comparator, no TCP form), the closed config and secret readers, the same build
 * digest the controller computes. Test harnesses build their own set outside production code (static check).
 */
const BUDGET_MS = 5000;
const pgConnect = async (o: pg.ClientConfig): Promise<QueryClient> => { const c = new pg.Client(o); await c.connect(); return c as unknown as QueryClient; };
export function productionMaintainDeps(): MaintainDeps {
  const physical = nodePhysicalDeps(o => pgConnect(o));
  return {
    loadConfig: loadOwnerConfig, readSecret: readSecretFile,
    connectOwner: (config, password, label) => verifyPhysicalEndpoint({ endpoint: config.endpoint, physical: config.physical, role: config.roles.owner,
      applicationName: label === 'primary' ? APPLICATION_NAME.maintain : APPLICATION_NAME.confirm, budgetMs: BUDGET_MS }, password, physical),
    observePhysical: (config, password) => observe(config, password),
    buildManifestSha256: async (config: OwnerConfig) => (await computeDigests(PROJECT_ROOT, realpathSync(process.execPath), config.nativePeerHelperSha256)).buildManifestSha256,
    loadDataset: () => loadFrozenDataset(),
    out: line => { process.stdout.write(`${line}\n`); },
  };
}
/**
 * `probe`: the owner's own observation of the recorded tuple for the configured unix endpoint and data directory (the
 * data directory is owner knowledge; a non-superuser cannot read it from the server). Only allowlisted identity metadata
 * is printed; the owner copies it into the 0600 config before `register`.
 */
async function observe(config: OwnerConfig, password: string): Promise<PhysicalTuple> {
  const { socketDir, port, database } = config.endpoint;
  const sock = await lstat(`${socketDir}/.s.PGSQL.${port}`);
  if (!sock.isSocket()) throw new PhysicalMismatchError('socket');
  const lines = (await readFile(`${config.physical.dataDirectory}/postmaster.pid`, 'utf8')).split('\n');
  if (lines.length < 5 || lines[1] !== config.physical.dataDirectory || lines[3]!.trim() !== String(port) || lines[4] !== socketDir) throw new PhysicalMismatchError('pid-file');
  const client = await pgConnect({ host: socketDir, port, database, user: config.roles.owner, password, application_name: APPLICATION_NAME.maintain,
    connectionTimeoutMillis: BUDGET_MS, statement_timeout: BUDGET_MS }).catch((e: unknown) => { throw connectFailure(e); });
  try {
    const row = (await client.query(PHYSICAL_QUERY)).rows[0]!;
    if (row.unix_socket !== true || row.session_user !== config.roles.owner || row.database !== database || row.start_epoch !== lines[2]) throw new PhysicalMismatchError('database');
    return { systemIdentifier: row.system_identifier as string, databaseOid: row.database_oid as string, postmasterStartTime: row.start_epoch as string,
      postmasterPid: lines[0]!, dataDirectory: config.physical.dataDirectory, socketDevice: String(sock.dev), socketInode: String(sock.ino) };
  } finally { await destroyClient(client); }
}
