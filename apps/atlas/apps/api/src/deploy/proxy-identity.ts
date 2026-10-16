import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BEARER_TOKEN_PATTERN } from '../../../../packages/auth/token.ts';
import { OPENAPI_DOCUMENT } from './openapi.ts';

/**
 * Deployed sign-in boundary (docs/deploy/DEPLOY.md). A person signs in with a Microsoft work account at oauth2-proxy (Entra ID;
 * the app is assigned to exactly the admitted users). oauth2-proxy forwards to the API with `Authorization: Basic
 * base64(<email>:<proxy secret>)` (`--pass-basic-auth`, `--prefer-email-to-user`, `--basic-auth-password`); only it and the API
 * know the secret. This middleware turns such a request into the request of that user's own Atlas actor by replacing the header
 * with the user's provisioned bearer token, so the accepted ApiTokenGuard, memberships and RLS decide everything after it.
 *
 * - `Authorization: Bearer …` (machine clients) or no Authorization: unchanged.
 * - Basic with a wrong secret, any Basic while the boundary is off, a duplicated Authorization: 401. A valid secret for an email
 *   without a provisioned actor: 403.
 * - `GET /session`: 200 `{ user }` for a proxy-signed-in request, else 401 (the console's sign-in probe).
 * - `GET /openapi.json`: the OpenAPI 3.1 description of the API (no data, no authentication).
 * Nothing is logged.
 */
export interface ProxyIdentityConfig { readonly secret: string; readonly users: ReadonlyMap<string, string> }

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const SECRET = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Reads ATLAS_PROXY_SECRET (32–256 characters, no ':' or whitespace) and ATLAS_PROXY_USERS (`email=ENV_NAME;…`, each ENV_NAME
 * holding that user's Atlas bearer token). Both unset: null (the boundary is off). Anything partial or malformed refuses to start.
 */
export function proxyIdentityFromEnv(env: Readonly<Record<string, string | undefined>>): ProxyIdentityConfig | null {
  const secret = env.ATLAS_PROXY_SECRET; const list = env.ATLAS_PROXY_USERS;
  if (secret === undefined && list === undefined) return null;
  if (secret === undefined || !SECRET.test(secret)) throw new Error('ATLAS_PROXY_SECRET must be 32-256 characters of [A-Za-z0-9._~+/=-]');
  if (list === undefined || list.trim() === '') throw new Error('ATLAS_PROXY_USERS must list email=ENV_NAME pairs');
  const users = new Map<string, string>();
  for (const pair of list.split(';').map(p => p.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    const email = pair.slice(0, at).trim().toLowerCase(); const name = pair.slice(at + 1).trim();
    if (at < 1 || !EMAIL.test(email) || !ENV_NAME.test(name) || users.has(email)) throw new Error('ATLAS_PROXY_USERS: malformed or duplicate pair');
    const token = env[name];
    if (token === undefined || !BEARER_TOKEN_PATTERN.test(token)) throw new Error(`ATLAS_PROXY_USERS: ${name} does not hold a bearer token`);
    users.set(email, token);
  }
  return { secret, users };
}

function answer(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); res.end(body);
}
/** Replaces the single Authorization header (parsed and raw) with the user's bearer token. */
function setBearer(req: IncomingMessage, token: string): void {
  req.headers.authorization = `Bearer ${token}`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'authorization') req.rawHeaders[i + 1] = req.headers.authorization;
}

export function proxyIdentityMiddleware(config: ProxyIdentityConfig | null) {
  const expected = config ? digest(config.secret) : null;
  const document = JSON.stringify(OPENAPI_DOCUMENT);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/openapi.json' && (req.method === 'GET' || req.method === 'HEAD')) return answer(res, 200, document, 'application/json');
    let authorizations = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'authorization') authorizations += 1;
    const header = req.headers.authorization;
    let email: string | null = null;
    if (authorizations > 1) return answer(res, 401, 'Unauthorized');
    if (header !== undefined && /^basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const secret = colon < 0 ? '' : decoded.slice(colon + 1);
      if (!expected || colon < 1 || !timingSafeEqual(digest(secret), expected)) return answer(res, 401, 'Unauthorized');
      const candidate = decoded.slice(0, colon).trim().toLowerCase();
      const token = config!.users.get(candidate);
      if (!token) return answer(res, 403, 'Forbidden');
      email = candidate;
      setBearer(req, token);
    }
    if (path === '/session' && req.method === 'GET') {
      return email ? answer(res, 200, JSON.stringify({ user: email }), 'application/json') : answer(res, 401, 'Unauthorized');
    }
    next();
  };
}
