// Private current-credential holder (docs/stage5/03_SECURITY_AND_STATE.md). The bearer token lives only in this closure:
// there is no getter, export, serialization, storage, URL, log or DOM write of it. The public surface is operations.
// Deployment (docs/deploy/DEPLOY.md): a SESSION credential carries no token at all — the edge's Microsoft sign-in cookie
// travels with the same-origin request and the server maps the signed-in user to that user's own actor.
import { BEARER_TOKEN_PATTERN } from './contracts.ts';
import { EVIDENCE_PATH, askBody, askPath, askRemoteBody, evidenceBody, operationPath } from './operations.ts';
import type { AskOperation, AskRemoteOperation, EvidenceOperation, GetOperation } from './operations.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CredentialHolder {
  /** Monotonic credential epoch. Every replacement or clear changes it, before any new request can be sent. */
  epoch(): number;
  connected(): boolean;
  /**
   * Destroys the current credential, then accepts `raw` exactly as typed when it satisfies the accepted bearer format.
   * Malformed input is refused without network and leaves the holder empty; nothing is trimmed or normalized.
   */
  replace(raw: string): boolean;
  /**
   * Destroys the current credential, then uses the edge sign-in session (no token; requests carry the same-origin cookie).
   * Optional: the R-EVAL measured console's holder has no session mode.
   */
  useSession?(): void;
  clear(): void;
  /** One fixed GET with the current credential, same-origin only. Rejects when there is no credential or no valid path. */
  get(operation: GetOperation, signal: AbortSignal): Promise<Response>;
  /** One allowlisted evidence read: POST /tools/execute with the exact closed body. Rejects without a credential or valid body. */
  execute(operation: EvidenceOperation, signal: AbortSignal): Promise<Response>;
  /**
   * One Ask question: POST /clients/:id/ask with the exact AskRequestV1 body built here (so its serialization runs inside
   * the caller's original deadline). Rejects without a credential, a valid client path or a valid body.
   */
  ask(operation: AskOperation, signal: AbortSignal): Promise<Response>;
  /**
   * One REMOTE question: the same POST /clients/:id/ask with the exact AskRequestV2 body built here from the closed remote
   * operation (its captured acknowledgement included). Rejects without a credential, a valid client path or a valid body.
   */
  askRemote(operation: AskRemoteOperation, signal: AbortSignal): Promise<Response>;
}

const FIXED_OPTIONS = { credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer' } as const;
/** The edge session needs its same-origin sign-in cookie; a bearer token never travels with a cookie. */
const SESSION_OPTIONS = { ...FIXED_OPTIONS, credentials: 'same-origin' } as const;

export function createCredentialHolder(fetchImpl: FetchLike): CredentialHolder {
  let token: string | null = null;
  let session = false;
  let epoch = 0;
  const live = () => token !== null || session;
  /** The request headers of the current credential: the bearer token, or none for the edge session. */
  const headersFor = (extra: Record<string, string>) => new Headers(token === null ? extra : { ...extra, Authorization: `Bearer ${token}` });
  const options = () => token === null ? SESSION_OPTIONS : FIXED_OPTIONS;
  return Object.freeze({
    epoch: () => epoch,
    connected: live,
    replace(raw: string): boolean {
      token = null; session = false; epoch += 1;
      if (typeof raw !== 'string' || !BEARER_TOKEN_PATTERN.test(raw)) return false;
      token = raw;
      return true;
    },
    useSession(): void { token = null; session = true; epoch += 1; },
    clear(): void { token = null; session = false; epoch += 1; },
    get(operation: GetOperation, signal: AbortSignal): Promise<Response> {
      const path = operationPath(operation);
      if (!live() || path === null) return Promise.reject(new Error('REQUEST_REFUSED'));
      return fetchImpl(path, { method: 'GET', headers: headersFor({ Accept: 'application/json' }), ...options(), signal });
    },
    execute(operation: EvidenceOperation, signal: AbortSignal): Promise<Response> {
      const body = evidenceBody(operation);
      if (!live() || body === null) return Promise.reject(new Error('REQUEST_REFUSED'));
      const headers = headersFor({ Accept: 'application/json', 'Content-Type': 'application/json' });
      return fetchImpl(EVIDENCE_PATH, { method: 'POST', headers, body, ...options(), signal });
    },
    ask(operation: AskOperation, signal: AbortSignal): Promise<Response> {
      return post(askPath(operation.clientId), askBody(operation), signal);
    },
    askRemote(operation: AskRemoteOperation, signal: AbortSignal): Promise<Response> {
      return post(askPath(operation.clientId), askRemoteBody(operation), signal);
    }
  });

  /** The Ask POST of a validated path and body; nothing is sent without both and a current credential. */
  function post(path: string | null, body: string | null, signal: AbortSignal): Promise<Response> {
    if (!live() || path === null || body === null) return Promise.reject(new Error('REQUEST_REFUSED'));
    const headers = headersFor({ Accept: 'application/json', 'Content-Type': 'application/json' });
    return fetchImpl(path, { method: 'POST', headers, body, ...options(), signal });
  }
}
