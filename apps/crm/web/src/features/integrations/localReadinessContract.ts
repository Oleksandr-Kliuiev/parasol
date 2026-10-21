import { z } from 'zod';

const time = z.iso.datetime({ offset: true });
const localCount = z.number().int().nonnegative().max(2_147_483_647);
const storedSchema = z.strictObject({ paused: z.boolean(), lastSucceededAt: time.nullable(), records: localCount,
  unlinkedRecords: localCount, pendingOutbound: localCount, failedOutbound: localCount });
const providerSchema = z.strictObject({ enabled: z.boolean(), writeEnabled: z.boolean(), stored: storedSchema.nullable() });
const schema = z.strictObject({
  status: z.enum(['LOCAL_SNAPSHOT', 'PARTIAL']), checkedAt: time, scope: z.literal('LOCAL_ONLY'), connectivity: z.literal('NOT_CHECKED'),
  admin: z.strictObject({
    authMode: z.enum(['ENTRA', 'DEVELOPMENT']), atera: providerSchema, powerOffice: providerSchema,
    microsoftGraph: z.strictObject({ enabled: z.boolean(), calendarEnabled: z.boolean(), mailEnabled: z.boolean(), sharePointEnabled: z.boolean(),
      teamsEnabled: z.boolean(), stored: z.strictObject({ directoryLastSucceededAt: time.nullable(), roleLastSucceededAt: time.nullable() }).nullable() }),
  }),
});
export type LocalReadinessView = z.infer<typeof schema>;
export type ReadinessProvider = z.infer<typeof providerSchema>;

/** Local metadata only; reject unexpected sections and any connection-validity claim. */
export function parseLocalReadiness(value: unknown): LocalReadinessView | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data; const a = v.admin;
  if ([a.atera, a.powerOffice].some(p => p.stored && p.stored.unlinkedRecords > p.stored.records)) return null;
  const partial = !a.atera.stored || !a.powerOffice.stored || !a.microsoftGraph.stored;
  return (v.status === 'PARTIAL') === partial ? v : null;
}
