import type { ResourceType } from '../../packages/core/contracts.ts';
import { AtlasError, safeErrorCode } from '../../packages/core/contracts.ts';
import { assertResolvedConnection } from '../../packages/connections/connections.ts';
import type { AtlasConnector, ConnectorDeps, ResolvedConnection, SnapshotRead, IdentityRead, ConnectionHealth } from '../contracts.ts';
import { getJson } from '../http.ts';
import { paginationInconsistent } from '../dto.ts';
import { ATERA_BASE_URL, ATERA_CONTRACT_VERSION, parsePage, parseTicket, parseAgent, parseCustomerId, ticketItem, agentIdentity } from './contract.ts';

/**
 * Atera read adapter (task 1.5), contract UNVERIFIED against the account (connectors/atera/contract.ts).
 *   tickets  GET /api/v3/tickets?customerId=<tenant>&ticketStatus=Open  — server-side customer filter
 *   agents   GET /api/v3/agents/customer/<tenant>                       — customer in the path
 *   health   GET /api/v3/customers/<tenant>
 *   alerts   NOT READ: GET /api/v3/alerts has no customer filter, and docs/01 (condition 5) requires the upstream request
 *            itself to be limited to the bound customer, not only its result. The context shows the reason code.
 * Every record is checked again; one that names another customer fails the whole read. Pages: 50 items (documented
 * maximum), at most ATERA_MAX_PAGES. A read is complete only if its pages agree (review B4): the same totals on every page,
 * no empty page before the declared last one, no repeated ID, and exactly totalItemCount records in the end.
 */
export const ATERA_PAGE_SIZE = 50;
export const ATERA_MAX_PAGES = 40;

function customerId(connection: ResolvedConnection): string {
  if (!/^[1-9][0-9]{0,15}$/.test(connection.externalTenantId)) throw new AtlasError('TENANT_ID_FORMAT_INVALID', 'PERMANENT');
  return connection.externalTenantId;
}
/** The current export documents JWT bearer authentication ("Authorization: Bearer {token}"). */
async function authorization(deps: ConnectorDeps, connection: ResolvedConnection): Promise<Record<string, string>> {
  const token = await deps.credential(connection);
  if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) throw new AtlasError('CREDENTIAL_FORMAT_INVALID', 'PERMANENT');
  return { Authorization: `Bearer ${token}` };
}

export function createAteraConnector(deps: ConnectorDeps): AtlasConnector {
  /** `request` builds path and filters from the validated customer ID, so nothing is requested before both checks passed. */
  async function readAll<T extends { id: string; customerId: string }>(connection: ResolvedConnection,
    request: (customer: string) => { path: string; filters: Record<string, string> }, item: (value: unknown) => T): Promise<T[]> {
    // Credential first: it is the gate for any upstream access (a FIXTURE connection is refused there).
    const headers = await authorization(deps, connection);
    const customer = customerId(connection);
    const { path, filters } = request(customer);
    const records: T[] = [];
    const seen = new Set<string>();
    let totals: { totalPages: number; totalItemCount: number } | null = null;
    for (let page = 1; ; page++) {
      const url = new URL(path, ATERA_BASE_URL);
      for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
      url.searchParams.set('page', String(page));
      url.searchParams.set('itemsInPage', String(ATERA_PAGE_SIZE));
      const result = parsePage(await getJson(deps.transport, url, headers), item);
      if (result.page !== page) throw new AtlasError('UPSTREAM_CONTRACT_MISMATCH', 'PERMANENT', { field: 'page' });
      if (result.items.some(r => r.customerId !== customer)) throw new AtlasError('UPSTREAM_SCOPE_MISMATCH', 'PERMANENT');
      totals ??= { totalPages: result.totalPages, totalItemCount: result.totalItemCount };
      if (result.totalPages !== totals.totalPages) throw paginationInconsistent('totalPages');
      if (result.totalItemCount !== totals.totalItemCount) throw paginationInconsistent('totalItemCount');
      for (const r of result.items) { if (seen.has(r.id)) throw paginationInconsistent('id'); seen.add(r.id); }
      records.push(...result.items);
      if (page >= totals.totalPages) {
        if (records.length !== totals.totalItemCount) throw paginationInconsistent('totalItemCount');
        return records;
      }
      if (result.items.length === 0) throw paginationInconsistent('items');
      if (page >= ATERA_MAX_PAGES) throw new AtlasError('UPSTREAM_TOO_MANY_PAGES', 'PERMANENT');
    }
  }
  return {
    system: 'atera',
    snapshotResources: ['ticket'],
    unavailableResources: { alert: 'UPSTREAM_TENANT_FILTER_UNAVAILABLE' },
    async healthCheck(connection: ResolvedConnection): Promise<ConnectionHealth> {
      assertResolvedConnection(connection);
      const checkedAt = new Date().toISOString();
      try {
        const headers = await authorization(deps, connection);
        const url = new URL(`/api/v3/customers/${customerId(connection)}`, ATERA_BASE_URL);
        const found = parseCustomerId(await getJson(deps.transport, url, headers));
        return found === connection.externalTenantId ? { status: 'OK', checkedAt } : { status: 'ERROR', checkedAt, safeErrorCode: 'UPSTREAM_SCOPE_MISMATCH' };
      } catch (error) { return { status: 'ERROR', checkedAt, safeErrorCode: safeErrorCode(error) }; }
    },
    async readSnapshot(connection: ResolvedConnection, resourceType: ResourceType): Promise<SnapshotRead> {
      assertResolvedConnection(connection);
      if (resourceType !== 'ticket') throw new AtlasError('RESOURCE_NOT_SUPPORTED', 'PERMANENT');
      const tickets = await readAll(connection, customer => ({ path: '/api/v3/tickets', filters: { customerId: customer, ticketStatus: 'Open' } }), parseTicket);
      return { resourceType, items: tickets.map(ticketItem), itemCount: tickets.length, contractVersion: ATERA_CONTRACT_VERSION, events: [] };
    },
    async readIdentities(connection: ResolvedConnection): Promise<IdentityRead[]> {
      assertResolvedConnection(connection);
      const fetchedAt = new Date().toISOString();
      return (await readAll(connection, customer => ({ path: `/api/v3/agents/customer/${customer}`, filters: {} }), parseAgent)).map(a => agentIdentity(a, fetchedAt));
    }
  };
}
