import { readFileSync } from 'node:fs';
import type { HttpTransport } from '../../connectors/http.ts';

/** Synthetic vendor responses (fixtures/vendor, see its README): shaped after the contracts, never recorded from an account. */
export const vendorFixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/vendor/${path}`, import.meta.url), 'utf8'));

export interface Reply { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
export interface RecordedRequest { url: URL; headers: Record<string, string> }

/**
 * Scoped mock vendor: `route` answers per URL, anything it does not know is a 404, and every request is recorded, so a
 * test can assert the upstream tenant filter, the auth header, and that an endpoint was never called. No network.
 */
export function mockVendor(route: (url: URL) => Reply | undefined): { transport: HttpTransport; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const transport: HttpTransport = async (raw, init) => {
    const url = new URL(raw);
    requests.push({ url, headers: { ...init.headers } });
    const reply = route(url) ?? { status: 404, body: { error: 'not found' } };
    const body = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } });
  };
  return { transport, requests };
}
