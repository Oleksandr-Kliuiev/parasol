import type { Reply } from './m365-graph-mock.ts';
import { signInRow } from './m365-graph-mock.ts';

/**
 * Synthetic Graph signIns endpoint for the window tests: honours the documented inclusive `createdDateTime ge X and
 * createdDateTime le Y` filter of each leaf, pages with `$skiptoken` nextLinks on the same path (the filter carried in the
 * link, as Graph does), and lets a test inject a reply for one leaf/page (429, 403, 503, malformed, out-of-window rows).
 */
export interface SignInData { id: string; at: string; extra?: Record<string, unknown> }
export interface SignInRouteOptions {
  pageSize?: number;
  /** Reply override by leaf bounds and page index (0-based); undefined → normal page. */
  inject?: (from: Date, to: Date, pageIndex: number) => Reply | undefined;
  /** Count of requests per leaf "from|to" key, for assertions. */
  seen?: Map<string, number>;
}
export function signInRoute(data: () => readonly SignInData[], options: SignInRouteOptions = {}) {
  return (url: URL): Reply | undefined => {
    if (url.pathname !== '/v1.0/auditLogs/signIns') return undefined;
    const filter = /^createdDateTime ge (\S+) and createdDateTime le (\S+)$/.exec(url.searchParams.get('$filter') ?? '');
    if (!filter) return { status: 400, body: { error: { code: 'BadRequest' } } };
    const from = new Date(filter[1]!); const to = new Date(filter[2]!);
    const offset = Number(url.searchParams.get('$skiptoken') ?? '0');
    const size = options.pageSize ?? Number(url.searchParams.get('$top') ?? '500');
    const pageIndex = Math.floor(offset / size);
    const key = `${from.toISOString()}|${to.toISOString()}`;
    options.seen?.set(key, (options.seen.get(key) ?? 0) + 1);
    const injected = options.inject?.(from, to, pageIndex);
    if (injected) return injected;
    const rows = data().filter(r => { const t = Date.parse(r.at); return t >= from.getTime() && t <= to.getTime(); })
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const slice = rows.slice(offset, offset + size).map(r => signInRow(r.id, r.at, r.extra));
    const more = offset + size < rows.length;
    const next = new URL(url.toString()); next.searchParams.set('$skiptoken', String(offset + size));
    return { status: 200, body: more ? { value: slice, '@odata.nextLink': next.toString() } : { value: slice } };
  };
}
/** The last complete UTC hour minus `hoursBack` (collectable and retained for any test clock near now). */
export function hourStart(hoursBack: number, now: number = Date.now()): Date {
  return new Date(Math.floor(now / 3_600_000) * 3_600_000 - hoursBack * 3_600_000);
}
export const iso = (base: Date, plusMs: number) => new Date(base.getTime() + plusMs).toISOString();
