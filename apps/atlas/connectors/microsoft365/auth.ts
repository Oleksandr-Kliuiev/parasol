import { createHash } from 'node:crypto';
import { AtlasError } from '../../packages/core/contracts.ts';
import { GRAPH_SCOPE, TENANT_GUID, m365Limits, tokenEndpoint } from './contract.ts';
import { readJson, transportError } from './http.ts';
import type { AuthTransport } from './http.ts';

/**
 * Token acquisition for Microsoft Graph (docs/stage2/03_CONNECTOR_SYNC.md §2). TokenProvider is separate from the GET-only
 * Graph transport; the production provider performs exactly one kind of request: an OAuth client_credentials POST to the
 * fixed tenant-specific authority endpoint with the Graph `.default` scope, refusing redirects. Tokens are opaque (never
 * parsed as proof of tenant — connector.ts verifies the organization with the same token), live only in memory and never
 * reach an error, a log, an audit row or the database. Certificates or federated credentials can replace this provider
 * later without changing the authority rules.
 */
export interface M365Credential { applicationId: string; clientSecret: string }
export interface AccessToken { value: string; expiresAtMs: number }
export interface TokenProvider { acquire(tenantId: string, credential: M365Credential): Promise<AccessToken> }

const credentialInvalid = () => new AtlasError('M365_CREDENTIAL_INVALID', 'PERMANENT');
/**
 * The secret behind an M365 connection's secretRef is `<application (client) ID GUID>:<client secret>`, resolved in memory
 * for one acquisition. The value is never echoed: a malformed one is only M365_CREDENTIAL_INVALID.
 */
export function parseM365Credential(secret: string): M365Credential {
  const separator = secret.indexOf(':');
  const applicationId = secret.slice(0, separator).toLowerCase();
  const clientSecret = secret.slice(separator + 1);
  if (separator !== 36 || !TENANT_GUID.test(applicationId) || clientSecret.length === 0 || clientSecret.length > 1024
    || /[\u0000-\u001f\u007f]/.test(clientSecret)) throw credentialInvalid();
  return { applicationId, clientSecret };
}

const tokenInvalid = () => new AtlasError('M365_TOKEN_RESPONSE_INVALID', 'PERMANENT');
export class ClientCredentialsTokenProvider implements TokenProvider {
  readonly #transport: AuthTransport; readonly #now: () => number;
  constructor(transport: AuthTransport, now: () => number = Date.now) { this.#transport = transport; this.#now = now; }
  async acquire(tenantId: string, credential: M365Credential): Promise<AccessToken> {
    if (!TENANT_GUID.test(tenantId)) throw new AtlasError('M365_TENANT_INVALID', 'PERMANENT');
    const body = new URLSearchParams({ client_id: credential.applicationId, client_secret: credential.clientSecret, scope: GRAPH_SCOPE,
      grant_type: 'client_credentials' }).toString();
    let response: Response;
    try {
      response = await this.#transport(tokenEndpoint(tenantId), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(m365Limits.pageTimeoutMs) });
    } catch (error) { throw transportError(error); }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // The authority's error body (error codes, trace IDs, sometimes the tenant) is discarded unread.
      await response.body?.cancel().catch(() => undefined);
      throw new AtlasError('M365_AUTH_FAILED', 'PERMANENT');
    }
    const json = await readJson(response, m365Limits.maxTokenBytes, this.#now());
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw tokenInvalid();
    const { token_type: type, access_token: token, expires_in: expiresIn } = json as Record<string, unknown>;
    const seconds = typeof expiresIn === 'number' ? expiresIn : typeof expiresIn === 'string' && /^\d{1,6}$/.test(expiresIn) ? Number(expiresIn) : NaN;
    if (typeof type !== 'string' || type.toLowerCase() !== 'bearer' || typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)
      || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) throw tokenInvalid();
    // A token that would already be inside the refresh margin is a bounded failure, never a tight reacquisition loop.
    if (seconds * 1000 <= m365Limits.tokenRefreshMarginMs) throw new AtlasError('M365_TOKEN_LIFETIME_TOO_SHORT', 'PERMANENT');
    return { value: token, expiresAtMs: this.#now() + seconds * 1000 };
  }
}

/**
 * Process-local token cache. The key is the credential-version identity of this stage: workspace, client, connection,
 * bound tenant, application ID, secretRef (hashed) and the connection's lifecycleVersion — no token is ever shared across
 * clients, connections or versions. A new lifecycleVersion (m365-disable, activation) makes old entries unreachable in every
 * process because the caller's authority recheck pins the CURRENT version before looking up; m365-disable also evicts the
 * local entries. Entries are dropped once inside the refresh margin.
 */
export interface TokenCacheKey {
  workspaceId: string; clientId: string; connectionId: string; tenantId: string; applicationId: string; secretRef: string; lifecycleVersion: number;
}
interface Entry { scope: string; token: AccessToken }
const entries = new Map<string, Entry>();
const scopeKey = (workspaceId: string, clientId: string, connectionId: string) => JSON.stringify([workspaceId, clientId, connectionId]);
const cacheKey = (k: TokenCacheKey) => JSON.stringify([k.workspaceId, k.clientId, k.connectionId, k.tenantId, k.applicationId,
  createHash('sha256').update(k.secretRef, 'utf8').digest('hex'), k.lifecycleVersion]);

export const m365TokenCache = {
  get(key: TokenCacheKey, now: number): AccessToken | null {
    const id = cacheKey(key); const entry = entries.get(id);
    if (!entry) return null;
    if (now >= entry.token.expiresAtMs - m365Limits.tokenRefreshMarginMs) { entries.delete(id); return null; }
    return entry.token;
  },
  set(key: TokenCacheKey, token: AccessToken): void {
    entries.set(cacheKey(key), { scope: scopeKey(key.workspaceId, key.clientId, key.connectionId), token });
  },
  delete(key: TokenCacheKey): void { entries.delete(cacheKey(key)); },
  /** Local eviction of every entry of one connection (all versions); used by m365-disable after its commit. */
  evictConnection(workspaceId: string, clientId: string, connectionId: string): number {
    const scope = scopeKey(workspaceId, clientId, connectionId); let n = 0;
    for (const [id, entry] of entries) if (entry.scope === scope) { entries.delete(id); n++; }
    return n;
  },
  size(): number { return entries.size; },
  clear(): void { entries.clear(); },
};
