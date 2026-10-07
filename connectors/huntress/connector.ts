import type { ResourceType } from '../../packages/core/contracts.ts';
import { AtlasError, safeErrorCode } from '../../packages/core/contracts.ts';
import { assertResolvedConnection } from '../../packages/connections/connections.ts';
import type { AtlasConnector, ConnectorDeps, ResolvedConnection, SnapshotRead, IdentityRead, ConnectionHealth } from '../contracts.ts';
import { getJson } from '../http.ts';
import { HUNTRESS_BASE_URL, HUNTRESS_CONTRACT_VERSION, parsePage, parseAgent, parseIncident, parseOrganizationId, incidentItem, agentIdentity } from './contract.ts';
import type { HuntressPage } from './contract.ts';

/**
 * Huntress read adapter (task 1.5). Every list request carries organization_id = the bound tenant (the documented
 * server-side filter), so the upstream read itself is scoped; every record is checked again and one that names another
 * organization fails the whole read (UPSTREAM_SCOPE_MISMATCH) instead of being dropped silently. Reads are bounded:
 * HUNTRESS_PAGE_LIMIT records per page (documented maximum 500), at most HUNTRESS_MAX_PAGES pages; the account limit is
 * 60 requests per minute, a 429 surfaces as TRANSIENT with Retry-After for the scheduler.
 */
export const HUNTRESS_PAGE_LIMIT = 100;
export const HUNTRESS_MAX_PAGES = 20;

function organizationId(connection: ResolvedConnection): string {
  if (!/^[1-9][0-9]{0,15}$/.test(connection.externalTenantId)) throw new AtlasError('TENANT_ID_FORMAT_INVALID', 'PERMANENT');
  return connection.externalTenantId;
}
/** Basic authentication: base64 of "<api key>:<api secret>", as documented. The vault holds that pair as one secret. */
async function authorization(deps: ConnectorDeps, connection: ResolvedConnection): Promise<Record<string, string>> {
  const credential = await deps.credential(connection);
  if (!/^[^:\s]+:[^\s]+$/.test(credential)) throw new AtlasError('CREDENTIAL_FORMAT_INVALID', 'PERMANENT');
  return { Authorization: `Basic ${Buffer.from(credential, 'utf8').toString('base64')}` };
}

export function createHuntressConnector(deps: ConnectorDeps): AtlasConnector {
  async function readAll<T extends { organizationId: string }>(connection: ResolvedConnection, path: string, key: string,
    filters: Record<string, string>, item: (value: unknown) => T): Promise<T[]> {
    // Credential first: it is the gate for any upstream access (a FIXTURE connection is refused there).
    const headers = await authorization(deps, connection);
    const org = organizationId(connection);
    const records: T[] = [];
    let token: string | null = null;
    for (let page = 1; ; page++) {
      const url = new URL(path, HUNTRESS_BASE_URL);
      url.searchParams.set('organization_id', org);
      url.searchParams.set('limit', String(HUNTRESS_PAGE_LIMIT));
      for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
      if (token) url.searchParams.set('page_token', token);
      const result: HuntressPage<T> = parsePage(await getJson(deps.transport, url, headers), key, item);
      if (result.items.some(r => r.organizationId !== org)) throw new AtlasError('UPSTREAM_SCOPE_MISMATCH', 'PERMANENT');
      records.push(...result.items);
      token = result.nextPageToken;
      if (!token) return records;
      if (page >= HUNTRESS_MAX_PAGES) throw new AtlasError('UPSTREAM_TOO_MANY_PAGES', 'PERMANENT');
    }
  }
  return {
    system: 'huntress',
    snapshotResources: ['incident'],
    unavailableResources: {},
    async healthCheck(connection: ResolvedConnection): Promise<ConnectionHealth> {
      assertResolvedConnection(connection);
      const checkedAt = new Date().toISOString();
      try {
        const headers = await authorization(deps, connection);
        const url = new URL(`/v1/organizations/${organizationId(connection)}`, HUNTRESS_BASE_URL);
        const found = parseOrganizationId(await getJson(deps.transport, url, headers));
        return found === connection.externalTenantId ? { status: 'OK', checkedAt } : { status: 'ERROR', checkedAt, safeErrorCode: 'UPSTREAM_SCOPE_MISMATCH' };
      } catch (error) { return { status: 'ERROR', checkedAt, safeErrorCode: safeErrorCode(error) }; }
    },
    async readSnapshot(connection: ResolvedConnection, resourceType: ResourceType): Promise<SnapshotRead> {
      assertResolvedConnection(connection);
      if (resourceType !== 'incident') throw new AtlasError('RESOURCE_NOT_SUPPORTED', 'PERMANENT');
      // Open incident reports: status `sent` (SOC notified; not closed or dismissed).
      const reports = await readAll(connection, '/v1/incident_reports', 'incident_reports', { status: 'sent' }, parseIncident);
      return { resourceType, items: reports.map(incidentItem), itemCount: reports.length, contractVersion: HUNTRESS_CONTRACT_VERSION };
    },
    async readIdentities(connection: ResolvedConnection): Promise<IdentityRead[]> {
      assertResolvedConnection(connection);
      const fetchedAt = new Date().toISOString();
      return (await readAll(connection, '/v1/agents', 'agents', {}, parseAgent)).map(a => agentIdentity(a, fetchedAt));
    }
  };
}
