import { z } from 'zod';
import { count, deviceSchema, observationSchema, resourceSchema, time, validTechnicalReferences } from './technicalContract';
import { taskLinkSchema, taskLinks } from './observationTaskContract';

const coverageSchema = z.strictObject({
  visibleClients: count, matchedCustomers: count, selectedCustomers: count.max(50), attemptedCustomers: count.max(50),
  readyCustomers: count.max(50), failedCustomers: count.max(50), omittedCustomers: count, unmappedClients: count,
  mappingIssues: count, limitReached: z.boolean(), timedOut: z.boolean(),
});
const totalsSchema = z.strictObject({ activeObservations: count, high: count, critical: count });
const customerSchema = z.strictObject({
  customerId: z.guid(), customerName: z.string().min(1).max(256),
  status: z.enum(['READY', 'NOT_LINKED', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'SOURCE_NOT_FOUND', 'UNAVAILABLE',
    'INVALID_RESPONSE', 'IDENTITY_CHANGED', 'TIMEOUT', 'CUSTOMER_UNAVAILABLE']),
  mode: z.enum(['db', 'fixture']).nullable(), generatedAt: time.nullable(), retrievedAt: time.nullable(),
  completeness: z.enum(['COMPLETE', 'PARTIAL', 'COMPLETE_FIXTURE']).nullable(),
  activeObservations: count.nullable(), high: count.nullable(), critical: count.nullable(),
  // Three urgent rows per customer on My day, up to ten in the observation queue (the caller's limit is checked below).
  resources: z.array(resourceSchema).max(100).nullable(), preview: z.array(observationSchema).max(10),
  devices: z.array(deviceSchema).max(10),
  // The CRM tasks the preview rows already have (UX 2026, В3); null when the read did not include them.
  tasks: z.array(taskLinkSchema).max(10).nullable(),
});
const responseSchema = z.strictObject({
  status: z.enum(['READY', 'PARTIAL', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'UNAVAILABLE', 'INVALID_RESPONSE']),
  checkedAt: time, coverage: coverageSchema.nullable(), totals: totalsSchema.nullable(),
  customers: z.array(customerSchema).max(50).nullable(),
});
export type AtlasAttentionView = z.infer<typeof responseSchema>;
export type AtlasAttentionCustomer = z.infer<typeof customerSchema>;

const validCoverage = (c: z.infer<typeof coverageSchema>) => c.visibleClients === c.matchedCustomers + c.unmappedClients + c.mappingIssues
  && c.selectedCustomers === Math.min(c.matchedCustomers, 50) && c.omittedCustomers === c.matchedCustomers - c.selectedCustomers
  && c.readyCustomers + c.failedCustomers === c.selectedCustomers && c.readyCustomers <= c.attemptedCustomers
  && c.attemptedCustomers <= c.selectedCustomers && c.limitReached === (c.omittedCustomers > 0);

function validCustomer(c: AtlasAttentionCustomer, limit: number): boolean {
  if (c.status !== 'READY') return c.mode === null && c.generatedAt === null && c.retrievedAt === null && c.completeness === null
    && c.activeObservations === null && c.high === null && c.critical === null && c.resources === null
    && c.preview.length === 0 && c.devices.length === 0 && c.tasks === null;
  if (c.tasks && !taskLinks(c.tasks, c.customerId, c.preview.map(o => o.id))) return false;
  if (c.mode === null || c.generatedAt === null || c.retrievedAt === null || c.completeness === null
    || c.activeObservations === null || c.high === null || c.critical === null || c.resources === null
    || (c.mode === 'fixture') !== (c.completeness === 'COMPLETE_FIXTURE')
    || c.activeObservations < c.high + c.critical || c.preview.length !== Math.min(limit, c.high + c.critical)
    || !validTechnicalReferences(c.devices, c.preview, c.resources)) return false;
  if (c.preview.some(o => !['HIGH', 'CRITICAL'].includes(o.severity) || !['OPEN', 'ACKNOWLEDGED'].includes(o.status))
    || c.preview.filter(o => o.severity === 'HIGH').length > c.high || c.preview.filter(o => o.severity === 'CRITICAL').length > c.critical
    || c.preview.some((o, i) => o.severity === 'CRITICAL' && c.preview[i - 1]?.severity === 'HIGH')) return false;
  const referenced = new Set(c.preview.flatMap(o => o.deviceId ? [o.deviceId] : []));
  return c.devices.length === referenced.size && c.devices.every(d => referenced.has(d.id));
}

/** The urgent rows My day shows per customer, and the observation queue's (AtlasAttentionReader.PreviewLimit, QueueLimit). */
export const attentionLimit = { myDay: 3, queue: 10 } as const;

/** A single personal read: never salvage customer rows from an invalid or denied aggregate. */
export function parseAtlasAttention(value: unknown, limit: number = attentionLimit.myDay): AtlasAttentionView {
  const invalid: AtlasAttentionView = { status: 'INVALID_RESPONSE', checkedAt: new Date(0).toISOString(), coverage: null, totals: null, customers: null };
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return invalid;
  const view = parsed.data; const c = view.coverage;
  if (c && !validCoverage(c)) return invalid;
  if (view.status !== 'READY' && view.status !== 'PARTIAL') return view.customers === null && view.totals === null ? view : invalid;
  if (!c || !view.totals || !view.customers || view.customers.length !== c.selectedCustomers
    || new Set(view.customers.map(row => row.customerId)).size !== view.customers.length
    || view.customers.some(row => row.status === 'ACCESS_DENIED' || !validCustomer(row, limit))) return invalid;
  const ready = view.customers.filter(row => row.status === 'READY');
  if (ready.length !== c.readyCustomers || view.totals.activeObservations !== ready.reduce((n, row) => n + row.activeObservations!, 0)
    || view.totals.high !== ready.reduce((n, row) => n + row.high!, 0) || view.totals.critical !== ready.reduce((n, row) => n + row.critical!, 0)) return invalid;
  const partial = c.unmappedClients > 0 || c.mappingIssues > 0 || c.limitReached || c.timedOut || c.failedCustomers > 0
    || ready.some(row => row.completeness !== 'COMPLETE');
  return (view.status === 'PARTIAL') === partial ? view : invalid;
}
