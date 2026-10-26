import { z } from 'zod';

const time = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().max(2_147_483_647);
// System, job and worker part names are identifiers, never sentences or addresses.
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const jobSchema = z.strictObject({
  job: name, freshness: z.enum(['Fresh', 'Stale', 'Never', 'Paused', 'Disabled']), lastSucceededAt: time.nullable(), ageMinutes: count.nullable(),
  thresholdMinutes: count, lastRunAt: time.nullable(), lastRunStatus: z.enum(['Running', 'Succeeded', 'Failed', 'Skipped']).nullable(),
  lastFailedAt: time.nullable(),
});
const integrationSchema = z.strictObject({
  system: name, enabled: z.boolean(), writeEnabled: z.boolean().nullable(),
  state: z.strictObject({ paused: z.boolean(), failedOutbound: count, jobs: z.array(jobSchema).max(50) }).nullable(),
});
const heartbeatSchema = z.strictObject({ component: name, state: z.enum(['Current', 'Late', 'Missing']), beatAt: time.nullable(), ageSeconds: count.nullable() });
const gapSchema = z.strictObject({
  kind: z.enum(['Never', 'Stale', 'Failed', 'Paused', 'OutboundFailed', 'WorkerLate', 'WorkerMissing']),
  system: name.nullable(), job: name.nullable(), component: name.nullable(), count: count.nullable(),
});
const schema = z.strictObject({
  status: z.enum(['Ready', 'Gaps', 'Unavailable']), checkedAt: time, integrations: z.array(integrationSchema).max(20),
  worker: z.strictObject({ staleAfterSeconds: count, components: z.array(heartbeatSchema).max(10) }).nullable(), gaps: z.array(gapSchema).max(500),
});

export type ConnectionStatusView = z.infer<typeof schema>;
export type ConnectionIntegration = z.infer<typeof integrationSchema>;
export type ConnectionJob = z.infer<typeof jobSchema>;
export type ConnectionGap = z.infer<typeof gapSchema>;
export type ConnectionHeartbeat = z.infer<typeof heartbeatSchema>;

/** The latest run failed after the last complete read: the data may still be fresh, the next read may not come. */
export const failedSinceRead = (job: ConnectionJob) =>
  job.lastFailedAt !== null && (job.lastSucceededAt === null || Date.parse(job.lastFailedAt) > Date.parse(job.lastSucceededAt));

/**
 * The CRM's own state of its integrations (M38). A reply whose status contradicts its own facts is refused whole, never shown
 * in part: green only with every switched-on job fresh, nothing paused or unsent and every worker part beating.
 */
export function parseConnectionStatus(value: unknown): ConnectionStatusView | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const view = parsed.data;
  if (view.status === 'Unavailable') return view.worker === null && view.integrations.every((i) => i.state === null) && view.gaps.length === 0 ? view : null;
  if (view.worker === null || view.integrations.some((i) => i.state === null)) return null;
  // A switched-off integration's jobs do not run: they are off, never "never read".
  if (view.integrations.some((i) => !i.enabled && i.state!.jobs.some((job) => job.freshness !== 'Disabled'))) return null;
  const complete = view.worker.components.every((c) => c.state === 'Current') && view.integrations.every((i) => !i.enabled
    || (!i.state!.paused && i.state!.failedOutbound === 0 && i.state!.jobs.every((job) => job.freshness === 'Fresh' && !failedSinceRead(job))));
  return (view.status === 'Ready') === (complete && view.gaps.length === 0) && (view.status === 'Gaps') === (view.gaps.length > 0) ? view : null;
}
