import { z } from 'zod';
import { count, time } from './technicalContract';

const status = z.enum(['OK', 'STALE', 'MISSING', 'ERROR']);
const directory = z.strictObject({ resourceType: z.enum(['m365_user', 'm365_device']), status,
  count: count.max(20_000).nullable(), asOf: time.nullable(), lastSuccessAt: time.nullable() });
const gap = z.strictObject({ fromInclusive: time, toExclusive: time });
const signIns = z.strictObject({ status, coverage: z.enum(['COMPLETE', 'PARTIAL', 'UNAVAILABLE']),
  freshness: z.enum(['FRESH', 'STALE', 'MIXED', 'UNKNOWN']), asOf: time.nullable(), lastSuccessAt: time.nullable(), gaps: z.array(gap).max(64) });
const summary = z.strictObject({ assessedAt: time, windowFrom: time, windowTo: time,
  totalConnections: count.max(2_147_483_647), truncated: z.boolean(), connections: z.array(z.strictObject({
    connectionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), directory: z.array(directory).length(2), signIns,
  })).max(8) });
const view = z.strictObject({ customerId: z.string(), status: z.enum(['READY', 'NOT_LINKED', 'NOT_CONFIGURED',
  'ACCESS_DENIED', 'NOT_SUPPORTED', 'UNAVAILABLE', 'INVALID_RESPONSE', 'IDENTITY_CHANGED']), summary: summary.nullable() });
export type M365View = z.infer<typeof view>;
export type M365Connection = z.infer<typeof summary>['connections'][number];
const ms = (value: string) => Date.parse(value);
const utc = (value: string) => /(?:Z|\+00:00)$/.test(value);

/** Reject scope, malformed counts/coverage and private extra fields before exposing any metadata. */
export function parseM365(value: unknown, customerId: string): M365View {
  const invalid: M365View = { customerId, status: 'INVALID_RESPONSE', summary: null };
  const parsed = view.safeParse(value);
  if (!parsed.success || parsed.data.customerId !== customerId) return invalid;
  const result = parsed.data;
  if (result.status !== 'READY') return result.summary === null ? result : invalid;
  const s = result.summary;
  if (!s) return invalid;
  const start = ms(s.windowFrom), end = ms(s.windowTo), assessed = ms(s.assessedAt);
  const validDate = (value: string | null) => value === null || utc(value) && ms(value) <= assessed;
  if (![s.assessedAt, s.windowFrom, s.windowTo].every(utc) || end - start !== 24 * 3_600_000
    || end % 3_600_000 !== 0 || assessed < end || assessed - end >= 3_600_000
    || s.connections.length !== Math.min(s.totalConnections, 8) || s.truncated !== (s.totalConnections > s.connections.length)
    || new Set(s.connections.map(c => c.connectionId)).size !== s.connections.length) return invalid;
  for (const connection of s.connections) {
    if (new Set(connection.directory.map(d => d.resourceType)).size !== 2) return invalid;
    for (const d of connection.directory) {
      const usable = d.status === 'OK' || d.status === 'STALE';
      if (!validDate(d.asOf) || !validDate(d.lastSuccessAt)
        || (usable ? d.count === null || d.asOf === null : d.count !== null || d.asOf !== null)) return invalid;
    }
    const si = connection.signIns; let position = start, missing = 0;
    if (!validDate(si.asOf) || !validDate(si.lastSuccessAt)) return invalid;
    for (const g of si.gaps) {
      const from = ms(g.fromInclusive), to = ms(g.toExclusive);
      if (!utc(g.fromInclusive) || !utc(g.toExclusive) || from < position || to <= from || to > end) return invalid;
      missing += to - from; position = to;
    }
    if (si.coverage === 'COMPLETE' ? si.gaps.length !== 0 : si.coverage === 'PARTIAL'
      ? missing <= 0 || missing >= end - start : missing !== end - start) return invalid;
    if (si.coverage === 'UNAVAILABLE') {
      if (!['MISSING', 'ERROR'].includes(si.status) || si.freshness !== 'UNKNOWN' || si.asOf !== null || si.lastSuccessAt !== null) return invalid;
    } else if ((si.freshness === 'FRESH' ? si.status !== 'OK' : !['STALE', 'MIXED'].includes(si.freshness) || si.status !== 'STALE')
      || si.asOf === null || si.lastSuccessAt === null || ms(si.lastSuccessAt) < ms(si.asOf)) return invalid;
  }
  return result;
}
