import { z } from 'zod';
import { count, deviceSchema, observationSchema, resourceSchema, severities, severityCountsSchema, time, validTechnicalReferences } from './technicalContract';

export const queueSeverities = ['ALL', 'URGENT', ...severities] as const;
export const queueStates = ['ACTIVE', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'] as const;
export type QueueSeverity = typeof queueSeverities[number];
export type QueueState = typeof queueStates[number];
export type QueueSelection = { severity: QueueSeverity; status: QueueState; cursor: string | null };
const queueSchema = z.strictObject({
  mode: z.literal('db'), generatedAt: time, retrievedAt: time,
  severity: z.enum(queueSeverities), status: z.enum(queueStates), total: count, severityCounts: severityCountsSchema,
  items: z.array(observationSchema).max(25), devices: z.array(deviceSchema).max(1000), resources: z.array(resourceSchema).max(100),
  nextCursor: z.string().min(1).max(2048).refine(s => s.trim().length > 0 && ![...s].some(c => c.charCodeAt(0) < 32)).nullable(),
});
const responseSchema = z.strictObject({
  customerId: z.string(), status: z.enum(['READY', 'NOT_LINKED', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'SOURCE_NOT_FOUND',
    'UNAVAILABLE', 'INVALID_RESPONSE', 'IDENTITY_CHANGED', 'INVALID_CURSOR', 'QUEUE_NOT_SUPPORTED']), queue: queueSchema.nullable(),
});
export type ObservationQueue = z.infer<typeof responseSchema>;

/** Treat a page as one closed read result, bound to this customer and its exact server filters. */
export function parseObservationQueue(value: unknown, customerId: string, selection: QueueSelection): ObservationQueue {
  const invalid: ObservationQueue = { customerId, status: 'INVALID_RESPONSE', queue: null };
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || parsed.data.customerId !== customerId) return invalid;
  const view = parsed.data; const q = view.queue;
  if (view.status !== 'READY') return q === null ? view : invalid;
  if (!q || q.severity !== selection.severity || q.status !== selection.status
    || q.total !== Object.values(q.severityCounts).reduce((a, b) => a + b, 0) || q.total < q.items.length
    || !validTechnicalReferences(q.devices, q.items, q.resources)
    || (q.nextCursor !== null && (q.items.length !== 25 || q.nextCursor === selection.cursor))
    || (selection.cursor === null && q.nextCursor === null && q.total !== q.items.length)) return invalid;
  for (const severity of severities) {
    const included = q.severity === 'ALL' || (q.severity === 'URGENT' ? severity === 'HIGH' || severity === 'CRITICAL' : severity === q.severity);
    if ((!included && q.severityCounts[severity] !== 0) || q.items.filter(o => o.severity === severity).length > q.severityCounts[severity]) return invalid;
  }
  if (q.items.some(o => q.status === 'ACTIVE' ? !['OPEN', 'ACKNOWLEDGED'].includes(o.status) : o.status !== q.status)) return invalid;
  return view;
}
