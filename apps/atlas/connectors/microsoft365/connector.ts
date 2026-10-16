import { AtlasError } from '../../packages/core/contracts.ts';
import { list, record } from '../dto.ts';
import { requiredGuid } from './dto-common.ts';
import { m365TokenCache, parseM365Credential } from './auth.ts';
import type { AccessToken, TokenCacheKey, TokenProvider } from './auth.ts';
import { organizationUrl, m365Limits } from './contract.ts';
import type { M365Endpoint } from './contract.ts';
import { assertGraphUrl, graphGet, nextLinkOf } from './http.ts';
import type { GraphTransport } from './http.ts';

/**
 * Graph session of one M365 operation (an activation probe, one directory job or one sign-in root attempt), following the
 * authority rules of docs/stage2/03_CONNECTOR_SYNC.md §2:
 *  - Before every secret resolution and before every vendor call the caller's authority is rechecked against the database
 *    (M365Authority.recheck: connection, binding, lifecycleVersion and the actor's current permissions). A disable that
 *    commits meanwhile makes the next call fail; an in-flight request may finish, but its result cannot be published.
 *  - Every newly acquired token is first used for GET /organization: exactly one organization whose ID equals the bound
 *    tenant, or M365_TENANT_MISMATCH — before any users/devices/signIns request and before the token is cached.
 *  - A 401 invalidates the token and allows ONE reacquisition (with its own tenant verification) per session; a second
 *    401 is M365_AUTH_FAILED. No refresh loop.
 * The session never sees a tenant, URL or token from a caller, model or response other than the validated nextLinks.
 */
export interface M365Authority {
  readonly workspaceId: string; readonly clientId: string; readonly connectionId: string;
  readonly tenantId: string; readonly lifecycleVersion: number;
  /** Throws unless the pinned connection, binding, version and the actor's authority are still current; returns the secretRef. */
  recheck(): Promise<{ secretRef: string }>;
  /** The secret of the (just rechecked) secretRef, in memory only. */
  resolveSecret(secretRef: string): Promise<string>;
}
export interface M365GraphIo { graph: GraphTransport; tokens: TokenProvider }
export interface GraphPage { body: unknown; nextLink: string | null }

export class M365GraphSession {
  readonly #authority: M365Authority; readonly #io: M365GraphIo; readonly #now: () => number;
  #token: AccessToken | null = null; #key: TokenCacheKey | null = null;
  /** The one 401 recovery of this session (= one attempt), shared by tenant verification and every collection page. */
  #reacquired = false;
  constructor(authority: M365Authority, io: M365GraphIo, now: () => number = Date.now) { this.#authority = authority; this.#io = io; this.#now = now; }

  /**
   * A token for this session: from the version-keyed cache unless `fresh`, otherwise newly acquired. The authority is
   * rechecked before the secret is resolved, again immediately before the token POST (a disable or withdrawn membership
   * during secret resolution sends nothing) and before the organization check. Only a token whose organization equals the
   * bound tenant is kept or cached.
   */
  async #acquire(fresh: boolean): Promise<string> {
    const a = this.#authority;
    const { secretRef } = await a.recheck();
    const credential = parseM365Credential(await a.resolveSecret(secretRef));
    const key: TokenCacheKey = { workspaceId: a.workspaceId, clientId: a.clientId, connectionId: a.connectionId, tenantId: a.tenantId,
      applicationId: credential.applicationId, secretRef, lifecycleVersion: a.lifecycleVersion };
    this.#key = key;
    const cached = fresh ? null : m365TokenCache.get(key, this.#now());
    if (cached) { this.#token = cached; return cached.value; }
    await a.recheck();
    const token = await this.#io.tokens.acquire(a.tenantId, credential);
    await a.recheck();
    await this.#verifyOrganization(token.value);
    m365TokenCache.set(key, token);
    this.#token = token;
    return token.value;
  }
  async #verifyOrganization(token: string): Promise<void> {
    const mismatch = () => new AtlasError('M365_TENANT_MISMATCH', 'PERMANENT');
    const body = await graphGet(this.#io.graph, 'organization', organizationUrl(), token, this.#now);
    if (nextLinkOf(body, 'organization') !== null) throw mismatch();
    const rows = list(record(body, 'root').value, 'value');
    if (rows.length !== 1) throw mismatch();
    let id: string;
    try { id = requiredGuid(record(rows[0], 'organization').id, 'organization.id'); } catch { throw mismatch(); }
    if (id !== this.#authority.tenantId) throw mismatch();
  }

  /**
   * Runs `call` with a current, tenant-verified token after a fresh authority recheck. A 401 — from the organization check
   * of a new token or from any page — drops the token (and its cache entry) and is retried once with a newly acquired,
   * newly verified token; a further 401 anywhere in the session is M365_AUTH_FAILED.
   */
  async #authorized<T>(call: (token: string) => Promise<T>): Promise<T> {
    let fresh = false;
    for (;;) {
      try {
        const held = this.#token;
        const token = held && this.#now() < held.expiresAtMs - m365Limits.tokenRefreshMarginMs ? held.value : await this.#acquire(fresh);
        await this.#authority.recheck(); // every vendor call
        return await call(token);
      } catch (error) {
        if (!(error instanceof AtlasError) || error.code !== 'M365_UNAUTHORIZED') throw error;
        if (this.#key) m365TokenCache.delete(this.#key);
        this.#token = null;
        if (this.#reacquired) throw new AtlasError('M365_AUTH_FAILED', 'PERMANENT');
        this.#reacquired = true; fresh = true;
      }
    }
  }

  /** One authorized Graph GET of a fixed contract URL or a validated nextLink of `endpoint` (graphGet enforces the boundary). */
  async get(endpoint: M365Endpoint, url: string): Promise<unknown> {
    assertGraphUrl(url, endpoint, 'M365_URL_REFUSED'); // before a secret is resolved or a token requested
    return this.#authorized(token => graphGet(this.#io.graph, endpoint, url, token, this.#now));
  }
  /** Token acquisition and tenant verification only (activation probe step 1). */
  async verifyTenant(): Promise<void> { await this.#authorized(async () => undefined); }

  /**
   * One traversal of a collection from a fixed first URL. Each page's nextLink is validated against the endpoint; a link
   * seen before in this traversal is M365_PAGINATION_LOOP. Page caps belong to the caller (directory/sign-in limits).
   */
  traverse(endpoint: M365Endpoint, firstUrl: string): { next(): Promise<GraphPage | null>; readonly pages: number } {
    const visited = new Set<string>();
    let url: string | null = firstUrl; let pages = 0;
    return {
      get pages() { return pages; },
      next: async () => {
        if (url === null) return null;
        if (visited.has(url)) throw new AtlasError('M365_PAGINATION_LOOP', 'PERMANENT');
        visited.add(url);
        const body = await this.get(endpoint, url);
        pages++;
        const nextLink = nextLinkOf(body, endpoint);
        url = nextLink;
        return { body, nextLink };
      },
    };
  }
}
