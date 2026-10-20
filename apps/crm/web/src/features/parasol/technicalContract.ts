import { z } from 'zod';

export const sources = z.enum(['atera', 'huntress', 'microsoft365', 'poweroffice']);
export const resourceTypes = z.enum(['customer', 'organization', 'agent', 'contact', 'alert', 'ticket', 'incident']);
export const severities = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const id = z.string().min(1).max(256).refine(s => s.trim().length > 0 && ![...s].some(c => c.charCodeAt(0) < 32));
export const time = z.iso.datetime({ offset: true });
export const count = z.number().int().nonnegative();
export const severityCountsSchema = z.strictObject({ INFO: count, LOW: count, MEDIUM: count, HIGH: count, CRITICAL: count });
export const resourceSchema = z.strictObject({
  source: sources, resourceType: resourceTypes, status: z.enum(['OK', 'STALE', 'ERROR', 'MISSING', 'FIXTURE']),
  asOf: time.nullable(), lastSuccessAt: time.nullable(), returnedItems: count.max(1000).nullable(), truncated: z.boolean(),
});
export const deviceSchema = z.strictObject({ id, hostname: id, sources: z.array(sources).max(4) });
export const observationSchema = z.strictObject({
  id, summary: z.string().max(300), source: sources, resourceType: resourceTypes,
  kind: z.enum(['DISK_CAPACITY', 'SECURITY_INCIDENT']), domain: z.enum(['OPERATIONS', 'SECURITY']),
  severity: z.enum(severities), priority: z.enum(['NORMAL', 'URGENT']), route: z.enum(['MONITOR', 'INVESTIGATE', 'HUMAN_REVIEW']),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED']), occurredAt: time, updatedAt: time,
  deviceStatus: z.enum(['CONFIRMED', 'UNRESOLVED', 'UNAVAILABLE']), deviceId: id.nullable(),
});
export type AtlasDevice = z.infer<typeof deviceSchema>;
export type AtlasObservation = z.infer<typeof observationSchema>;
export type AtlasResource = z.infer<typeof resourceSchema>;

/** The same source, urgency and confirmed-device rules apply to active lists and history pages. */
export function validTechnicalReferences(devices: AtlasDevice[], items: AtlasObservation[], resources: AtlasResource[]): boolean {
  const registry = new Map(devices.map(d => [d.id, d]));
  if (registry.size !== devices.length || devices.some(d => new Set(d.sources).size !== d.sources.length)
    || new Set(items.map(o => o.id)).size !== items.length) return false;
  if (items.some(o => o.priority !== (o.severity === 'HIGH' || o.severity === 'CRITICAL' ? 'URGENT' : 'NORMAL')
    || o.domain !== (o.kind === 'DISK_CAPACITY' ? 'OPERATIONS' : 'SECURITY')
    || (o.deviceStatus === 'CONFIRMED' ? o.deviceId === null || !registry.get(o.deviceId)?.sources.includes(o.source) : o.deviceId !== null))) return false;
  return !resources.some(r => ['OK', 'STALE', 'FIXTURE'].includes(r.status) ? r.returnedItems === null : r.returnedItems !== null);
}
