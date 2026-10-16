import { z } from 'zod';

const sources = z.enum(['atera', 'huntress', 'microsoft365', 'poweroffice']);
const resourceTypes = z.enum(['customer', 'organization', 'agent', 'contact', 'alert', 'ticket', 'incident']);
export const severities = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const id = z.string().min(1).max(256).refine(s => s.trim().length > 0 && ![...s].some(c => c.charCodeAt(0) < 32));
const time = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const summarySchema = z.strictObject({
  mode: z.enum(['db', 'fixture']), generatedAt: time, completeness: z.enum(['PARTIAL', 'COMPLETE', 'COMPLETE_FIXTURE']),
  knownDevices: count, knownPeople: count.max(1000), activeObservations: count,
  severityCounts: z.strictObject({ INFO: count, LOW: count, MEDIUM: count, HIGH: count, CRITICAL: count }),
  resources: z.array(z.strictObject({
    source: sources, resourceType: resourceTypes, status: z.enum(['OK', 'STALE', 'ERROR', 'MISSING', 'FIXTURE']),
    asOf: time.nullable(), lastSuccessAt: time.nullable(), returnedItems: count.max(1000).nullable(), truncated: z.boolean(),
  })).max(100),
  devices: z.array(z.strictObject({ id, hostname: id, sources: z.array(sources).max(4) })).max(1000),
  observationPage: z.strictObject({
    truncated: z.boolean(), items: z.array(z.strictObject({
      id, summary: z.string().max(300), source: sources, resourceType: resourceTypes,
      kind: z.enum(['DISK_CAPACITY', 'SECURITY_INCIDENT']), domain: z.enum(['OPERATIONS', 'SECURITY']),
      severity: z.enum(severities), priority: z.enum(['NORMAL', 'URGENT']), route: z.enum(['MONITOR', 'INVESTIGATE', 'HUMAN_REVIEW']),
      status: z.enum(['OPEN', 'ACKNOWLEDGED']), occurredAt: time, updatedAt: time,
      deviceStatus: z.enum(['CONFIRMED', 'UNRESOLVED', 'UNAVAILABLE']), deviceId: id.nullable(),
    })).max(100),
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
  const devices = new Map(s.devices.map(d => [d.id, d]));
  if (devices.size !== s.devices.length || s.devices.some(d => new Set(d.sources).size !== d.sources.length)) return invalid;
  const p = s.observationPage;
  if (new Set(p.items.map(o => o.id)).size !== p.items.length || s.activeObservations < p.items.length
    || p.truncated !== (s.activeObservations > p.items.length) || (p.truncated && (p.items.length === 0 || s.mode === 'fixture'))) return invalid;
  for (const severity of severities) {
    const returned = p.items.filter(o => o.severity === severity).length;
    if (p.truncated ? returned > s.severityCounts[severity] : returned !== s.severityCounts[severity]) return invalid;
  }
  if (p.items.some(o => o.priority !== (o.severity === 'HIGH' || o.severity === 'CRITICAL' ? 'URGENT' : 'NORMAL')
    || o.domain !== (o.kind === 'DISK_CAPACITY' ? 'OPERATIONS' : 'SECURITY')
    || (o.deviceStatus === 'CONFIRMED' ? o.deviceId === null || !devices.get(o.deviceId)?.sources.includes(o.source) : o.deviceId !== null))) return invalid;
  if (s.resources.some(r => ['OK', 'STALE', 'FIXTURE'].includes(r.status) ? r.returnedItems === null : r.returnedItems !== null)) return invalid;
  return view;
}
