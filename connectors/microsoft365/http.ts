import { AtlasError } from '../../packages/core/contracts.ts';
import { boundedText } from '../http.ts';
import { ENDPOINT_PATH, GRAPH_ORIGIN, GRAPH_VERSION, m365Limits } from './contract.ts';
import type { M365Endpoint } from './contract.ts';

/**
 * HTTP boundary of the Microsoft 365 connector (docs/stage2/03_CONNECTOR_SYNC.md §2, §6). Two transports with disjoint
 * shapes: Graph is GET-only, the identity authority POST-only (auth.ts); both refuse redirects. A failure is a safe code
 * and kind: no URL, query, header, token or response body ever reaches an error, a log or an audit row.
 *   3xx → M365_REDIRECT_REFUSED   401 → M365_UNAUTHORIZED (one reacquisition per attempt, connector.ts)
 *   403 → M365_ACCESS_DENIED (capability/access; never "empty" and never a license diagnosis)   404 → M365_NOT_FOUND
 *   429 → M365_RATE_LIMITED (TRANSIENT, the exact Retry-After seconds; above 24h M365_RETRY_AFTER_REJECTED, PERMANENT)
 *   5xx, network → M365_UPSTREAM_UNAVAILABLE, timeout → M365_UPSTREAM_TIMEOUT (TRANSIENT)
 *   oversized page → SYNC_LIMIT_EXCEEDED, invalid JSON → M365_INVALID_JSON, other status → M365_UNEXPECTED_STATUS (PERMANENT)
 */
export interface GraphRequestInit { method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }
export interface AuthRequestInit { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }
export type GraphTransport = (url: string, init: GraphRequestInit) => Promise<Response>;
export type AuthTransport = (url: string, init: AuthRequestInit) => Promise<Response>;
export const fetchGraphTransport: GraphTransport = (url, init) => fetch(url, init);
export const fetchAuthTransport: AuthTransport = (url, init) => fetch(url, init);

/**
 * Retry-After as delta seconds or an HTTP date. The value is honoured exactly (no Stage 1 one-hour clamp); null when absent
 * or unparsable (the caller uses its bounded fallback); 'REJECTED' when pathological (beyond 24 hours).
 */
export function parseRetryAfter(value: string | null, now: number): number | 'REJECTED' | null {
  const v = value?.trim() ?? '';
  let seconds: number | null = null;
  if (/^\d{1,10}$/.test(v)) seconds = Number(v);
  else if (v !== '' && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) {
    const at = Date.parse(v);
    if (Number.isFinite(at)) seconds = Math.max(0, Math.ceil((at - now) / 1000));
  }
  if (seconds === null) return null;
  return seconds > m365Limits.maxRetryAfterSeconds ? 'REJECTED' : seconds;
}

export function statusError(status: number, retryAfter: string | null, now: number): AtlasError {
  if (status >= 300 && status < 400) return new AtlasError('M365_REDIRECT_REFUSED', 'PERMANENT');
  if (status === 401) return new AtlasError('M365_UNAUTHORIZED', 'PERMANENT');
  if (status === 403) return new AtlasError('M365_ACCESS_DENIED', 'PERMANENT');
  if (status === 404) return new AtlasError('M365_NOT_FOUND', 'PERMANENT');
  if (status === 429) {
    const seconds = parseRetryAfter(retryAfter, now);
    if (seconds === 'REJECTED') return new AtlasError('M365_RETRY_AFTER_REJECTED', 'PERMANENT');
    return new AtlasError('M365_RATE_LIMITED', 'TRANSIENT', seconds === null ? {} : { retryAfterSeconds: String(seconds) });
  }
  if (status >= 500) return new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT', { httpStatus: String(status) });
  return new AtlasError('M365_UNEXPECTED_STATUS', 'PERMANENT', { httpStatus: String(status) });
}
export function transportError(error: unknown): AtlasError {
  const name = (error as { name?: unknown } | null)?.name;
  return new AtlasError(name === 'TimeoutError' || name === 'AbortError' ? 'M365_UPSTREAM_TIMEOUT' : 'M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT');
}

/** A 200 body, bounded and parsed; anything else is a classified AtlasError. */
export async function readJson(response: Response, maxBytes: number, now: number): Promise<unknown> {
  if (response.status !== 200) {
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel().catch(() => undefined);
    throw statusError(response.status, retryAfter, now);
  }
  let text: string;
  try { text = await boundedText(response, maxBytes); }
  catch (error) {
    if (error instanceof AtlasError && error.code === 'UPSTREAM_RESPONSE_TOO_LARGE') throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'pageBytes' });
    throw transportError(error);
  }
  try { return JSON.parse(text); } catch { throw new AtlasError('M365_INVALID_JSON', 'PERMANENT'); }
}

/**
 * One Graph GET with the bearer token, refusing redirects, bounded in time and size. The URL boundary is enforced here,
 * before any header is built: only https://graph.microsoft.com/v1.0 + exactly the endpoint's collection path (the fixed
 * first URLs of contract.ts or validated nextLinks) ever receives the token; anything else is M365_URL_REFUSED.
 */
export async function graphGet(transport: GraphTransport, endpoint: M365Endpoint, url: string, accessToken: string, now: () => number): Promise<unknown> {
  assertGraphUrl(url, endpoint, 'M365_URL_REFUSED');
  let response: Response;
  try {
    response = await transport(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }, redirect: 'error',
      signal: AbortSignal.timeout(m365Limits.pageTimeoutMs) });
  } catch (error) { throw transportError(error); }
  return readJson(response, m365Limits.maxPageBytes, now());
}

/**
 * The Graph URL rule shared by first URLs and nextLinks: https, exactly the Graph origin (no port, no userinfo), no
 * fragment, /v1.0 and exactly the endpoint's collection path, with a query. Whitespace, controls and backslashes (which
 * URL parsers rewrite) are refused outright, and the raw text must literally start with origin + path, so what is checked
 * is what is requested.
 */
export function assertGraphUrl(link: unknown, endpoint: M365Endpoint, code: 'M365_URL_REFUSED' | 'M365_INVALID_NEXT_LINK'): asserts link is string {
  const refuse = () => new AtlasError(code, 'PERMANENT');
  if (typeof link !== 'string' || link.length === 0 || link.length > 8192 || /[\s\u0000-\u001f\u007f\\#]/.test(link)) throw refuse();
  let url: URL;
  try { url = new URL(link); } catch { throw refuse(); }
  const path = `${GRAPH_VERSION}${ENDPOINT_PATH[endpoint]}`;
  if (url.protocol !== 'https:' || url.origin !== GRAPH_ORIGIN || url.port !== '' || url.username !== '' || url.password !== ''
    || url.hash !== '' || url.pathname !== path || !link.startsWith(`${GRAPH_ORIGIN}${path}?`)) throw refuse();
}
/** A nextLink is followed only under the same rule; it is requested as returned, its opaque query never spliced, stored or logged. */
export function validateNextLink(link: unknown, endpoint: M365Endpoint): string {
  assertGraphUrl(link, endpoint, 'M365_INVALID_NEXT_LINK');
  return link;
}
/** The validated `@odata.nextLink` of a page body, or null on the last page. A non-string link is a contract violation. */
export function nextLinkOf(body: unknown, endpoint: M365Endpoint): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AtlasError('UPSTREAM_CONTRACT_MISMATCH', 'PERMANENT', { field: 'root' });
  const link = (body as Record<string, unknown>)['@odata.nextLink'];
  return link === undefined || link === null ? null : validateNextLink(link, endpoint);
}
