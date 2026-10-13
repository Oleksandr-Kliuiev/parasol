// Private credential holder of the MEASURED console build (rs-c brief C §3). Same token rules as the accepted holder
// (apps/operator/src/credential.ts): the bearer exists only in this closure — no getter, export, serialization, storage, URL,
// log or DOM write; malformed input is refused, never trimmed; fixed same-origin fetch options. It exposes the accepted
// CredentialHolder operations unchanged (so the accepted controllers run on it) plus exactly three closed evaluation operations:
// PAIR (manual nonce), the evaluation Ask (the exact AskRequestV2 body with X-Atlas-Evaluation-Session) and RESPONSE. The pair
// session token also lives only here: set from a validated PAIR200, cleared by every credential change and every `endPair`.
import { BEARER_TOKEN_PATTERN } from '../src/contracts.ts';
import type { CredentialHolder, FetchLike } from '../src/credential.ts';
import { EVIDENCE_PATH, askBody, askPath, askRemoteBody, evidenceBody, operationPath } from '../src/operations.ts';
import type { AskOperation, AskRemoteOperation, EvidenceOperation, GetOperation } from '../src/operations.ts';
import { SESSION_HEADER, TOKEN_PATTERN, handoffPath, pairBody, responseBody } from './eval-contracts.ts';
import type { HandoffValues } from './eval-contracts.ts';

export interface MeasuredHolder extends CredentialHolder {
  /** Monotonic pair epoch: every adopt/end/credential change advances it (completions compare it). */
  pairEpoch(): number;
  paired(): boolean;
  /** POST the PAIR body for `nonce` (never trimmed) with the bearer; rejects without a credential, a valid path or a valid nonce. */
  pair(clientId: string, nonce: string, signal: AbortSignal): Promise<Response>;
  /** Keeps a validated PAIR200 session token for exactly the current credential epoch; false (nothing kept) otherwise. */
  adoptSession(sessionToken: string, credentialEpoch: number): boolean;
  /** Drops the session token (pair expiry/revocation/any invalidation). */
  endPair(): void;
  /** The evaluation Ask: exact AskRequestV2 body + session header. Rejects without credential, session, path or body. */
  askEvaluation(operation: AskRemoteOperation, signal: AbortSignal): Promise<Response>;
  /** RESPONSE of the exact exchanged values + session header. Rejects without credential, session, path or a valid body. */
  respond(clientId: string, values: HandoffValues, signal: AbortSignal): Promise<Response>;
}

const FIXED_OPTIONS = { credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer' } as const;

export function createMeasuredHolder(fetchImpl: FetchLike): MeasuredHolder {
  let token: string | null = null;
  let session: string | null = null;
  let epoch = 0; let pairEpoch = 0;
  const dropSession = () => { session = null; pairEpoch += 1; };
  return Object.freeze({
    epoch: () => epoch,
    connected: () => token !== null,
    pairEpoch: () => pairEpoch,
    paired: () => token !== null && session !== null,
    replace(raw: string): boolean {
      token = null; epoch += 1; dropSession();
      if (typeof raw !== 'string' || !BEARER_TOKEN_PATTERN.test(raw)) return false;
      token = raw;
      return true;
    },
    clear(): void { token = null; epoch += 1; dropSession(); },
    get(operation: GetOperation, signal: AbortSignal): Promise<Response> {
      const path = operationPath(operation);
      if (token === null || path === null) return Promise.reject(new Error('REQUEST_REFUSED'));
      const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${token}` });
      return fetchImpl(path, { method: 'GET', headers, ...FIXED_OPTIONS, signal });
    },
    execute(operation: EvidenceOperation, signal: AbortSignal): Promise<Response> {
      return post(EVIDENCE_PATH, evidenceBody(operation), null, signal);
    },
    ask(operation: AskOperation, signal: AbortSignal): Promise<Response> {
      return post(askPath(operation.clientId), askBody(operation), null, signal);
    },
    askRemote(operation: AskRemoteOperation, signal: AbortSignal): Promise<Response> {
      return post(askPath(operation.clientId), askRemoteBody(operation), null, signal);
    },
    pair(clientId: string, nonce: string, signal: AbortSignal): Promise<Response> {
      return post(handoffPath(clientId), pairBody(nonce), null, signal);
    },
    adoptSession(sessionToken: string, credentialEpoch: number): boolean {
      dropSession();
      if (token === null || credentialEpoch !== epoch || typeof sessionToken !== 'string' || !TOKEN_PATTERN.test(sessionToken)) return false;
      session = sessionToken;
      return true;
    },
    endPair(): void { dropSession(); },
    askEvaluation(operation: AskRemoteOperation, signal: AbortSignal): Promise<Response> {
      if (session === null) return Promise.reject(new Error('REQUEST_REFUSED'));
      return post(askPath(operation.clientId), askRemoteBody(operation), session, signal);
    },
    respond(clientId: string, values: HandoffValues, signal: AbortSignal): Promise<Response> {
      if (session === null) return Promise.reject(new Error('REQUEST_REFUSED'));
      return post(handoffPath(clientId), responseBody(values), session, signal);
    }
  });

  /** One POST of a validated path and body (plus the session header when given); nothing is sent without all of them. */
  function post(path: string | null, body: string | null, sessionToken: string | null, signal: AbortSignal): Promise<Response> {
    if (token === null || path === null || body === null) return Promise.reject(new Error('REQUEST_REFUSED'));
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    if (sessionToken !== null) headers.set(SESSION_HEADER, sessionToken);
    return fetchImpl(path, { method: 'POST', headers, body, ...FIXED_OPTIONS, signal });
  }
}
