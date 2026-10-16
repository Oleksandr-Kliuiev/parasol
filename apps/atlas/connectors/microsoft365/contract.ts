/**
 * Microsoft Graph v1.0 read contract of Stage 2 (docs/stage2/03_CONNECTOR_SYNC.md §1, §4, §5). Global commercial cloud
 * only: the identity authority and the Graph origin are fixed here and never taken from a caller, a model, a fixture or a
 * response. Every request URL is built from these constants; paging follows validated nextLinks only (http.ts).
 * All numeric limits are Atlas configuration (not Microsoft quotas); the SQL CHECKs of the Stage 2 migrations bound the
 * durable ones (leaves, rows, attempts) independently.
 */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_VERSION = '/v1.0';
export const AUTHORITY_ORIGIN = 'https://login.microsoftonline.com';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
/** Configuration version recorded on every sign-in request/attempt (SQL pattern ^[a-z0-9][a-z0-9._-]{0,63}$). */
export const M365_CONFIG_VERSION = 'm365-v1';

export type M365Endpoint = 'organization' | 'users' | 'devices' | 'signIns';
/** Collection path below /v1.0 of each endpoint; a nextLink must stay on exactly this path. */
export const ENDPOINT_PATH: Readonly<Record<M365Endpoint, string>> = Object.freeze({
  organization: '/organization', users: '/users', devices: '/devices', signIns: '/auditLogs/signIns',
});
const SELECT: Readonly<Record<'users' | 'devices', string>> = Object.freeze({
  users: 'id,displayName,userPrincipalName,userType,accountEnabled',
  devices: 'id,deviceId,displayName,accountEnabled,operatingSystem',
});
export const PAGE_SIZE = 500;

/** Lower-case tenant/directory GUID (not the nil GUID): the only form a bound tenant may take (Connection_m365_tenant_check). */
export const TENANT_GUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const tokenEndpoint = (tenantId: string): string => `${AUTHORITY_ORIGIN}/${tenantId}/oauth2/v2.0/token`;
const graphUrl = (endpoint: M365Endpoint, query: string): string => `${GRAPH_ORIGIN}${GRAPH_VERSION}${ENDPOINT_PATH[endpoint]}?${query}`;
export const organizationUrl = (): string => graphUrl('organization', '$select=id');
/** First page of a directory collection; `top` is PAGE_SIZE for reads and 1 for activation probes. */
export const directoryUrl = (endpoint: 'users' | 'devices', top: number = PAGE_SIZE): string => graphUrl(endpoint, `$select=${SELECT[endpoint]}&$top=${top}`);
/**
 * First page of a sign-in window: the documented inclusive ge/le filter on createdDateTime (no $select/$orderby, which the
 * endpoint does not document). Atlas enforces its half-open [from, to) locally (windows ingest).
 */
export function signInsUrl(from: Date, to: Date, top: number = PAGE_SIZE): string {
  const filter = `createdDateTime ge ${from.toISOString()} and createdDateTime le ${to.toISOString()}`;
  return graphUrl('signIns', `$filter=${encodeURIComponent(filter)}&$top=${top}`);
}

const MINUTE = 60_000;
export const m365Limits = Object.freeze({
  /** Per Graph page: response size and request timeout. */
  maxPageBytes: 5_000_000, pageTimeoutMs: 15_000,
  /** Authority token responses are small; anything larger is refused. */
  maxTokenBytes: 64_000,
  /** Token refresh margin; a token living shorter than this is a bounded failure, never a refresh loop. */
  tokenRefreshMarginMs: 120_000,
  directory: { maxPages: 40, maxRows: 20_000, jobDeadlineMs: 10 * MINUTE, leaseMs: 12 * MINUTE, retentionMs: 24 * 60 * MINUTE,
    /** Charged claims since the last publication or explicit reset (SQL CHECK 0..8): lets 30s backoff reach its 15m cap. */
    maxAttempts: 8 },
  signIns: {
    maxPagesPerLeaf: 20, maxRowsPerLeaf: 10_000, maxLeavesPerRoot: 60, maxLeavesPerRequest: 1_500,
    maxRowsPerRoot: 100_000, maxRowsPerRequest: 250_000, maxRootsPerRequest: 25, minLeafMs: MINUTE,
    attemptDeadlineMs: 10 * MINUTE, leaseMs: 12 * MINUTE, maxAttempts: 5, collectionDelayMs: 5 * MINUTE,
    retentionMs: 7 * 24 * 60 * MINUTE, unpublishedRetentionMs: 24 * 60 * MINUTE, maxRequestMs: 24 * 60 * MINUTE,
  },
  /** Transient backoff: exponential from 30s, at most 15 minutes; 429 without Retry-After: 60s plus bounded jitter. */
  backoff: { baseMs: 30_000, maxMs: 15 * MINUTE, rateLimitFallbackMs: 60_000, jitterMs: 10_000 },
  /** Retry-After above this is pathological: the job fails visibly instead of retrying earlier than the source asked. */
  maxRetryAfterSeconds: 86_400,
});
