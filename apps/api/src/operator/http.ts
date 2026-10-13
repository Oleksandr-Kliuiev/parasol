import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OperatorAssets } from './assets.ts';

/** docs/stage5/03_SECURITY_AND_STATE.md: exact console Content-Security-Policy. */
export const OPERATOR_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Headers on every response while the console is enabled: assets, API answers, 404s and refusals alike. */
export const OPERATOR_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': OPERATOR_CSP,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
});

const PREFIX = '/operator/';

function plain(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

/** Exactly one Host header with exactly the configured loopback authority. */
function hostAllowed(req: IncomingMessage, expected: string): boolean {
  let hosts = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'host') hosts += 1;
  return hosts === 1 && req.headers.host === expected;
}

/**
 * Opt-in console boundary, installed before every API route (main.ts, only with ATLAS_OPERATOR_UI=1):
 * 1. Host gate: anything but `Host: 127.0.0.1:<port>` and an origin-form target is refused (421) before static or API
 *    dispatch — no alias, forwarded header, proxy or CORS is honoured (DNS rebinding defence, not authentication).
 * 2. Security headers on every response.
 * 3. `/operator/` and the manifest's assets by exact path from memory; any other `/operator…` path is 404 (no listing,
 *    redirect, traversal, encoded variant or SPA fallback). Everything else continues to the unchanged API routes.
 * Logs nothing; never reads the Authorization header or the body.
 */
export function operatorMiddleware(port: number, assets: OperatorAssets) {
  const expectedHost = `127.0.0.1:${port}`;
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    for (const [name, value] of Object.entries(OPERATOR_HEADERS)) res.setHeader(name, value);
    const target = req.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//') || !hostAllowed(req, expectedHost)) return plain(res, 421, 'Misdirected Request');
    const query = target.indexOf('?');
    const path = query === -1 ? target : target.slice(0, query);
    if (path !== '/operator' && !path.startsWith(PREFIX)) return next();
    const asset = assets.get(path);
    if (!asset || (req.method !== 'GET' && req.method !== 'HEAD')) return plain(res, 404, 'Not Found');
    res.statusCode = 200;
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.body.byteLength));
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  };
}
