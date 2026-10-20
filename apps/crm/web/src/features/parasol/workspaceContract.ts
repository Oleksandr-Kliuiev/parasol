import { z } from 'zod';
import { count, deviceSchema, observationSchema, resourceSchema, severities, severityCountsSchema, time, validTechnicalReferences } from './technicalContract';

export { severities } from './technicalContract';
const summarySchema = z.strictObject({
  mode: z.enum(['db', 'fixture']), generatedAt: time, completeness: z.enum(['PARTIAL', 'COMPLETE', 'COMPLETE_FIXTURE']),
  knownDevices: count, knownPeople: count.max(1000), activeObservations: count,
  severityCounts: severityCountsSchema,
  resources: z.array(resourceSchema).max(100),
  devices: z.array(deviceSchema).max(1000),
  observationPage: z.strictObject({
    truncated: z.boolean(), items: z.array(observationSchema.extend({ status: z.enum(['OPEN', 'ACKNOWLEDGED']) })).max(100),
  }),
});
const workspaceSchema = z.strictObject({
  customerId: z.string(), status: z.enum(['READY', 'NOT_LINKED', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'SOURCE_NOT_FOUND',
    'UNAVAILABLE', 'INVALID_RESPONSE', 'IDENTITY_CHANGED']), summary: summarySchema.nullable(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceSummary = z.infer<typeof summarySchema>;

/** Reject the entire response before rendering; never keep a previous client's or partially validated details. */
export function parseWorkspace(value: unknown, customerId: string): Workspace {
  const invalid: Workspace = { customerId, status: 'INVALID_RESPONSE', summary: null };
  const parsed = workspaceSchema.safeParse(value);
  if (!parsed.success || parsed.data.customerId !== customerId) return invalid;
  const view = parsed.data;
  const s = view.summary;
  if (view.status !== 'READY') return s === null ? view : invalid;
  if (!s || (s.mode === 'fixture') !== (s.completeness === 'COMPLETE_FIXTURE') || s.knownDevices !== s.devices.length
    || s.activeObservations !== Object.values(s.severityCounts).reduce((a, b) => a + b, 0)) return invalid;
  const p = s.observationPage;
  if (!validTechnicalReferences(s.devices, p.items, s.resources) || s.activeObservations < p.items.length
    || p.truncated !== (s.activeObservations > p.items.length) || (p.truncated && (p.items.length === 0 || s.mode === 'fixture'))) return invalid;
  for (const severity of severities) {
    const returned = p.items.filter(o => o.severity === severity).length;
    if (p.truncated ? returned > s.severityCounts[severity] : returned !== s.severityCounts[severity]) return invalid;
  }
  return view;
}
