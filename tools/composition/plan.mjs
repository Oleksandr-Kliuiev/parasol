import { createHash } from 'node:crypto';

export const FORMAT = 1;
export const WORKSPACE = 'synthetic-composition-workspace';
export const ROLES = ['Crm.Admin', 'Crm.Technician', 'Crm.ServiceLead'];
export const REQUIRED_ARTIFACTS = [
  'apps/atlas/dist/apps/api/src/main.js',
  'apps/atlas/node_modules/.prisma/client/index.js',
  'apps/crm/src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll',
  'apps/crm/src/Hosts/Crm.Worker/bin/Release/net10.0/Crm.Worker.dll',
  'apps/crm/src/Hosts/Crm.Web/wwwroot/index.html',
];
export const SQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718';
export const PG_IMAGE = 'postgres:17@sha256:ae69c452f483507a6b99fb654cf93aad7fe156ffd2c56247707eef4e36d3c12b';

export function fixturePlan() {
  const clients = Array.from({ length: 40 }, (_, index) => {
    const label = String(index + 1).padStart(2, '0');
    return { atlasClientId: `composition-client-${label}`, name: `Synthetic Client ${label} AS`,
      deviceIds: Array.from({ length: 10 }, (_, d) => `device-${label}-${String(d + 1).padStart(2, '0')}`) };
  });
  return { workspaceId: WORKSPACE, clients, target: {
    atlasClientId: clients[0].atlasClientId, activeTotal: 126,
    severityCounts: { INFO: 0, LOW: 1, MEDIUM: 120, HIGH: 4, CRITICAL: 1 },
    criticalObservationId: 'observation-critical-old', criticalSummary: 'Synthetic older critical security incident',
    observationIdOutsideFirst100: 'observation-low-outside-overview', observationSummaryOutsideFirst100: 'Synthetic low observation outside the overview',
    resolvedObservationId: 'observation-resolved', resolvedSummary: 'Synthetic resolved observation',
    suppressedObservationId: 'observation-suppressed', suppressedSummary: 'Synthetic suppressed observation',
    duplicateHostname: 'SYNTHETIC-DUPLICATE-01', confirmedDeviceId: clients[0].deviceIds[0],
    unconfirmedDeviceId: clients[0].deviceIds[1], unconfirmedObservationId: 'observation-medium-001',
    unconfirmedSummary: 'Synthetic source association needs review',
  }, counts: { clients: 40, devices: 400, employees: 3 } };
}

export function visibleClients(role, clients) {
  if (role === ROLES[0]) return clients.map(c => c.atlasClientId);
  if (role === ROLES[1]) return clients.slice(0, 20).map(c => c.atlasClientId);
  if (role === ROLES[2]) return clients.slice(20).map(c => c.atlasClientId);
  throw new Error('Unsupported synthetic employee role.');
}

export function sourceKey(clientId, observationId) {
  return createHash('sha256').update(JSON.stringify(['SourceTaskV1', 'Atlas', WORKSPACE, clientId, observationId, 'Task'])).digest('hex');
}

export function parseArgs(argv) {
  const options = { skipBuild: false, skipBrowser: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--skip-browser') options.skipBrowser = true;
    else if (['--directory', '--sql-image', '--pg-image'].includes(arg) && argv[index + 1]) options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
    else throw new Error('Use --directory <new absolute state path>, optional --skip-build/--skip-browser and cached --sql-image/--pg-image.');
  }
  if (!options.directory) throw new Error('--directory is required; existing state is never reused.');
  return options;
}

export function assertPrivateState(state) {
  if (state?.format !== FORMAT || state.kind !== 'parasol-local-composition' || !/^[a-f0-9]{12}$/.test(state.runId)
    || !/^crm_e2e_composition_[a-f0-9]{12}$/.test(state.sqlDatabase)
    || !state.atlasOwnerUrl || !/^atlas_it_[a-f0-9]{8}$/.test(new URL(state.atlasOwnerUrl).pathname.slice(1)))
    throw new Error('Refusing an unrecognized composition state.');
  if (state.sqlContainer !== `parasol-composition-${state.runId}-sql` || state.pgContainer !== `parasol-composition-${state.runId}-pg`
    || ![state.ports?.sql, state.ports?.pg].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
    || state.sqlDatabase !== `crm_e2e_composition_${state.runId}`)
    throw new Error('Refusing foreign database container references.');
  for (const [kind, login] of [['owner', 'sa'], ['web', 'composition_web'], ['worker', 'composition_worker']]) {
    const value = state.sqlConnections?.[kind];
    if (typeof value !== 'string') throw new Error('Missing confined SQL connection configuration.');
    const parts = new Map();
    for (const pair of value.split(';').filter(Boolean)) {
      const [rawKey, ...rest] = pair.split('='); const key = rawKey.replace(/\s/g, '').toLowerCase();
      if (parts.has(key)) throw new Error('Ambiguous SQL connection configuration.');
      parts.set(key, rest.join('='));
    }
    if (parts.size !== 6 || parts.get('server') !== `127.0.0.1,${state.ports.sql}` || parts.get('database') !== state.sqlDatabase
      || parts.get('userid') !== login || !/^[A-Za-z0-9!]{32,128}$/.test(parts.get('password') ?? '')
      || parts.get('encrypt') !== 'True' || parts.get('trustservercertificate') !== 'True')
      throw new Error('Refusing a remote, privileged or mismatched SQL fixture connection.');
  }
  for (const value of [state.atlasOwnerUrl, state.atlasRuntimeUrl]) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.port !== String(state.ports.pg) || parsed.pathname !== new URL(state.atlasOwnerUrl).pathname || parsed.search || parsed.hash)
      throw new Error('Composition databases must be the same owned loopback database.');
  }
}

export function assertOwnedContainerLabel(state, name, label) {
  if (![state.sqlContainer, state.pgContainer].includes(name) || label !== state.runId
    || !name.startsWith(`parasol-composition-${state.runId}-`)) throw new Error('Refusing a foreign database container.');
}

export function assertOwnedContainerNetwork(state, name, info) {
  assertOwnedContainerLabel(state, name, info?.Config?.Labels?.['parasol.composition.run']);
  const sql = name === state.sqlContainer; const mappings = info.NetworkSettings?.Ports?.[sql ? '1433/tcp' : '5432/tcp'];
  if (!Array.isArray(mappings) || mappings.length !== 1 || mappings[0].HostIp !== '127.0.0.1'
    || mappings[0].HostPort !== String(state.ports[sql ? 'sql' : 'pg']))
    throw new Error('Refusing a database endpoint not bound to its owned container.');
}
