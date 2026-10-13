import { ClientCredentialsTokenProvider } from '../../connectors/microsoft365/auth.ts';
import type { AuthTransport, GraphTransport } from '../../connectors/microsoft365/http.ts';
import type { SecretResolver } from '../../connectors/contracts.ts';
import { AtlasError } from '../../packages/core/contracts.ts';
import { guid } from '../m365-sql-invariants.ts';

/**
 * Captured mock of the Microsoft identity authority and Graph v1.0 (synthetic, no network). Every request is recorded with
 * method, exact URL, headers, body and redirect mode, so tests can prove which calls were — or were never — made and that
 * no bearer token left for a wrong URL. Unknown Graph URLs answer 404. No ID here exists in a real tenant.
 */
export const M365_APP = guid('9');
export const M365_SECRET_VALUE = `${M365_APP}:synthetic-client-secret`;
export interface Reply { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
export interface Captured { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body: string | null; redirect: string }
export interface MockOptions {
  /** Tenant the organization endpoint reports (default: the bound tenant passed to mockM365). */
  organization?: () => Reply;
  /** Graph collection routes (users/devices/signIns), by parsed URL and the zero-based count of earlier GETs of that path. */
  route?: (url: URL, n: number) => Reply | undefined;
  /** Token endpoint replies, by zero-based POST count (default: a fresh bearer token valid for an hour). */
  token?: (n: number) => Reply;
}
export function mockM365(tenant: string, options: MockOptions = {}) {
  const requests: Captured[] = [];
  const perPath = new Map<string, number>();
  let posts = 0;
  const respond = (reply: Reply) => new Response(reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body)),
    { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } });
  const graph: GraphTransport = async (raw, init) => {
    requests.push({ method: init.method, url: raw, headers: { ...init.headers }, body: null, redirect: init.redirect });
    const url = new URL(raw);
    const n = perPath.get(url.pathname) ?? 0; perPath.set(url.pathname, n + 1);
    if (url.pathname === '/v1.0/organization') return respond(options.organization?.() ?? { status: 200, body: { value: [{ id: tenant }] } });
    return respond(options.route?.(url, n) ?? { status: 404, body: { error: { code: 'NotFound' } } });
  };
  const auth: AuthTransport = async (raw, init) => {
    requests.push({ method: init.method, url: raw, headers: { ...init.headers }, body: init.body, redirect: init.redirect });
    const n = posts++;
    return respond(options.token?.(n) ?? { status: 200, body: { token_type: 'Bearer', access_token: `synthetic-token-${n}`, expires_in: 3600 } });
  };
  return {
    graph, auth, requests, tokens: new ClientCredentialsTokenProvider(auth),
    posts: () => requests.filter(r => r.method === 'POST'),
    gets: (path?: string) => requests.filter(r => r.method === 'GET' && (path === undefined || new URL(r.url).pathname === path)),
    collectionGets: () => requests.filter(r => r.method === 'GET' && new URL(r.url).pathname !== '/v1.0/organization'),
  };
}
export type M365Mock = ReturnType<typeof mockM365>;

/** Secret resolver of tests: env:// references only, from a synthetic map; optionally gated to observe the resolution window. */
export function syntheticSecrets(values: Record<string, string> = { 'env://M365_GASTA': M365_SECRET_VALUE }): SecretResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(secretRef: string) {
      calls.push(secretRef);
      const value = values[secretRef];
      if (!value) throw new AtlasError('SECRET_NOT_FOUND', 'PERMANENT');
      return value;
    },
  };
}

/** Graph collection page body with an optional nextLink. */
export const page = (value: unknown[], nextLink?: string) => ({ status: 200, body: nextLink ? { value, '@odata.nextLink': nextLink } : { value } });
export const userRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: 'Synthetic User', userPrincipalName: 'user@example.invalid',
  userType: 'Member', accountEnabled: true, ...extra });
export const deviceRow = (id: string, deviceId: string | null, extra: Record<string, unknown> = {}) => ({ id, deviceId, displayName: 'SYNTH-LT',
  accountEnabled: true, operatingSystem: 'Windows', ...extra });
export const signInRow = (id: string, createdDateTime: string, extra: Record<string, unknown> = {}) => ({ id, createdDateTime, userId: guid('d'),
  deviceDetail: { deviceId: guid('e'), displayName: 'DROP-ME' }, appId: guid('f'), status: { errorCode: 0, failureReason: 'DROP-ME' }, isInteractive: true,
  ipAddress: '203.0.113.9', location: { city: 'DROP-ME' }, userPrincipalName: 'drop@example.invalid', ...extra });
