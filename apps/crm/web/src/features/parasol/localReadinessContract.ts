import { z } from 'zod';
import { count, time } from './technicalContract';

const localCount = count.max(2_147_483_647);
const storedSchema = z.strictObject({ paused: z.boolean(), lastSucceededAt: time.nullable(), records: localCount,
  unlinkedRecords: localCount, pendingOutbound: localCount, failedOutbound: localCount });
const providerSchema = z.strictObject({ enabled: z.boolean(), writeEnabled: z.boolean(), stored: storedSchema.nullable() });
const mappingsSchema = z.strictObject({
  status: z.enum(['CHECKED', 'INCOMPLETE', 'CHANGED', 'UNAVAILABLE']),
  reviewStatus: z.enum(['NO_LOCAL_ISSUES_FOUND', 'REQUIRED', 'UNKNOWN']), scope: z.literal('STORED_LOCAL_REGISTRY'), limit: z.literal(500),
  coverage: z.strictObject({ storedLinks: localCount, examinedLinks: localCount.max(500), omittedLinks: localCount, unlinkedStoredReferences: localCount }).nullable(),
  counts: z.strictObject({ validLinks: localCount, invalidIdentities: localCount, missingReferences: localCount,
    goneReferences: localCount, invalidReferences: localCount, unavailableCustomers: localCount }).nullable(),
});
const schema = z.strictObject({
  status: z.enum(['LOCAL_SNAPSHOT', 'PARTIAL']), checkedAt: time, scope: z.literal('LOCAL_ONLY'), connectivity: z.literal('NOT_CHECKED'),
  personalAtlas: z.strictObject({ status: z.enum(['DISABLED', 'PERSONAL_ENTRY_PRESENT', 'PERSONAL_ENTRY_MISSING']) }).nullable(),
  admin: z.strictObject({
    authMode: z.enum(['ENTRA', 'DEVELOPMENT']), atera: providerSchema, powerOffice: providerSchema,
    microsoftGraph: z.strictObject({ enabled: z.boolean(), calendarEnabled: z.boolean(), mailEnabled: z.boolean(), sharePointEnabled: z.boolean(),
      teamsEnabled: z.boolean(), stored: z.strictObject({ directoryLastSucceededAt: time.nullable(), roleLastSucceededAt: time.nullable() }).nullable() }),
    huntress: z.strictObject({ managedBy: z.literal('ATLAS'), configuration: z.literal('UNKNOWN'), connectivity: z.literal('NOT_CHECKED') }),
    atlasMappings: mappingsSchema.nullable(),
  }).nullable(),
});
export type LocalReadinessView = z.infer<typeof schema>;
export type ReadinessAuthority = { atlasRead: boolean; integrationsManage: boolean; customersRead: boolean };
export type ReadinessProvider = z.infer<typeof providerSchema>;
export type ReadinessMappings = z.infer<typeof mappingsSchema>;

function validMappings(m: ReadinessMappings): boolean {
  if (m.status === 'CHANGED' || m.status === 'UNAVAILABLE') return m.coverage === null && m.counts === null && m.reviewStatus === 'UNKNOWN';
  const c = m.coverage; const n = m.counts;
  if (!c || !n || c.storedLinks !== c.examinedLinks + c.omittedLinks || c.examinedLinks !== Math.min(c.storedLinks, 500)
    || Object.values(n).reduce((sum, value) => sum + value, 0) !== c.examinedLinks
    || (m.status === 'INCOMPLETE') !== (c.omittedLinks > 0)) return false;
  const review = c.omittedLinks > 0 || c.unlinkedStoredReferences > 0 || n.validLinks !== c.examinedLinks;
  return m.reviewStatus === (review ? 'REQUIRED' : 'NO_LOCAL_ISSUES_FOUND');
}

/** Local metadata only; reject unexpected privilege sections and any connection-validity claim. */
export function parseLocalReadiness(value: unknown, authority: ReadinessAuthority): LocalReadinessView | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success || (!authority.atlasRead && !authority.integrationsManage)) return null;
  const v = parsed.data;
  if ((v.personalAtlas !== null) !== authority.atlasRead || (v.admin !== null) !== authority.integrationsManage) return null;
  const a = v.admin;
  if (a && ((a.atlasMappings !== null) !== authority.customersRead || (a.atlasMappings && !validMappings(a.atlasMappings))
    || [a.atera, a.powerOffice].some(p => p.stored && p.stored.unlinkedRecords > p.stored.records))) return null;
  const partial = !!a && (!a.atera.stored || !a.powerOffice.stored || !a.microsoftGraph.stored
    || !!a.atlasMappings && a.atlasMappings.status !== 'CHECKED');
  return (v.status === 'PARTIAL') === partial ? v : null;
}
