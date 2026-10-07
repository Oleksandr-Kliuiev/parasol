import { AtlasError } from '../packages/core/contracts.ts';

/**
 * Vendor HTTP for the read adapters (task 1.5). The transport is injected, so tests run against a scoped mock and only the
 * production composition uses fetch. A failure becomes a safe code and kind (docs/03, error classes) and never carries the
 * URL query, a header, the credential or a response body:
 *   401/403 → UPSTREAM_AUTH_FAILED (PERMANENT)      404 → UPSTREAM_NOT_FOUND (PERMANENT)
 *   429 → UPSTREAM_RATE_LIMITED (TRANSIENT, retryAfterSeconds from Retry-After, at most an hour)
 *   5xx, network failure, timeout → TRANSIENT      other status, invalid JSON, oversized body → PERMANENT
 */
export type HttpTransport = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
export const fetchTransport: HttpTransport = (url, init) => fetch(url, init);

export interface HttpLimits { timeoutMs: number; maxBodyBytes: number }
export const defaultHttpLimits: HttpLimits = { timeoutMs: 15_000, maxBodyBytes: 5_000_000 };

export function retryAfterSeconds(value: string | null, now: number = Date.now()): string {
  const v = value?.trim() ?? '';
  if (/^\d{1,7}$/.test(v)) return String(Math.min(3600, Number(v)));
  const at = Date.parse(v);
  return Number.isFinite(at) ? String(Math.min(3600, Math.max(0, Math.ceil((at - now) / 1000)))) : '60';
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AtlasError('UPSTREAM_RESPONSE_TOO_LARGE', 'PERMANENT');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new AtlasError('UPSTREAM_RESPONSE_TOO_LARGE', 'PERMANENT'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** GET one JSON document; anything but a bounded, parseable 200 is a classified AtlasError. */
export async function getJson(transport: HttpTransport, url: URL, headers: Record<string, string>, limits: HttpLimits = defaultHttpLimits): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(url.toString(), { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(limits.timeoutMs) });
  } catch (error) {
    throw new AtlasError((error as { name?: unknown } | null)?.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', 'TRANSIENT');
  }
  const status = response.status;
  if (status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (status === 429) throw new AtlasError('UPSTREAM_RATE_LIMITED', 'TRANSIENT', { retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) });
    if (status === 401 || status === 403) throw new AtlasError('UPSTREAM_AUTH_FAILED', 'PERMANENT', { httpStatus: String(status) });
    if (status === 404) throw new AtlasError('UPSTREAM_NOT_FOUND', 'PERMANENT');
    if (status >= 500) throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT', { httpStatus: String(status) });
    throw new AtlasError('UPSTREAM_UNEXPECTED_STATUS', 'PERMANENT', { httpStatus: String(status) });
  }
  let text: string;
  try { text = await boundedText(response, limits.maxBodyBytes); }
  catch (error) { if (error instanceof AtlasError) throw error; throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT'); }
  try { return JSON.parse(text); } catch { throw new AtlasError('UPSTREAM_INVALID_JSON', 'PERMANENT'); }
}
