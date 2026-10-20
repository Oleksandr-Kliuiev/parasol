import { z } from 'zod';
import { deviceSchema, id, observationSchema, time, validTechnicalReferences } from './technicalContract';

const taskSchema = z.strictObject({
  activityId: id, organizationId: id, status: z.enum(['Open', 'Done', 'Cancelled']), assigneeId: id.nullable(), dueAt: time.nullable(),
  created: z.boolean(), isAvailable: z.boolean(),
});
const sourceStates = ['NOT_LINKED', 'NOT_CONFIGURED', 'ACCESS_DENIED', 'SOURCE_NOT_FOUND', 'UNAVAILABLE', 'INVALID_RESPONSE',
  'IDENTITY_CHANGED', 'OBSERVATION_NOT_FOUND', 'SOURCE_TASK_UNAVAILABLE'] as const;
const previewSchema = z.strictObject({
  customerId: id, status: z.enum(['READY', ...sourceStates]), mode: z.enum(['db', 'fixture']).nullable(), observation: observationSchema.nullable(),
  devices: z.array(deviceSchema).max(1000).nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  task: taskSchema.nullable(), canCreate: z.boolean(),
});
const outcomeSchema = z.strictObject({
  customerId: id, status: z.enum(['CREATED', 'EXISTING']), task: taskSchema,
});
export type ObservationTaskPreview = z.infer<typeof previewSchema>;
export type ObservationTaskOutcome = z.infer<typeof outcomeSchema> | { customerId: string; status: 'INVALID_RESPONSE'; task: null };
export type TechnicalTaskRef = z.infer<typeof taskSchema>;
export type TaskPreviewScope = { customerId?: string; observationId?: string; activityId?: string };

export function invalidTaskPreview(customerId: string): ObservationTaskPreview {
  return { customerId, status: 'INVALID_RESPONSE', mode: null, observation: null, devices: null, sha256: null, task: null, canCreate: false };
}

/** Source details stay in this personal read and never become task metadata or a browser-authored write. */
export function parseTaskPreview(value: unknown, scope: TaskPreviewScope): ObservationTaskPreview {
  const invalid = invalidTaskPreview(scope.customerId ?? 'unknown');
  const parsed = previewSchema.safeParse(value);
  if (!parsed.success || (scope.customerId && parsed.data.customerId !== scope.customerId)) return invalid;
  const view = parsed.data;
  if (view.task && (view.task.organizationId !== view.customerId || view.task.created
    || (scope.activityId && view.task.activityId !== scope.activityId)
    || (!view.task.isAvailable && (view.task.assigneeId !== null || view.task.dueAt !== null)))) return invalid;
  if (view.status !== 'READY') return view.observation === null && view.devices === null && view.sha256 === null && !view.canCreate ? view : invalid;
  if (!view.mode || !view.observation || !view.devices || !view.sha256
    || (scope.observationId && view.observation.id !== scope.observationId)
    || !validTechnicalReferences(view.devices, [view.observation], [])
    || (scope.activityId && !view.task)
    || (view.canCreate && (view.task !== null || !['OPEN', 'ACKNOWLEDGED'].includes(view.observation.status)))) return invalid;
  return view;
}

export function parseTaskOutcome(value: unknown, customerId: string): ObservationTaskOutcome {
  const invalid: ObservationTaskOutcome = { customerId, status: 'INVALID_RESPONSE', task: null };
  const parsed = outcomeSchema.safeParse(value);
  if (!parsed.success || parsed.data.customerId !== customerId) return invalid;
  const view = parsed.data;
  if (view.task.organizationId !== customerId || view.task.created !== (view.status === 'CREATED')
    || (!view.task.isAvailable && (view.task.assigneeId !== null || view.task.dueAt !== null))
    || (view.status === 'CREATED' && (!view.task.isAvailable || view.task.status !== 'Open' || !view.task.assigneeId))) return invalid;
  return view;
}

export function invalidatesAtlasSource(status: string): boolean {
  return ['ACCESS_DENIED', 'NOT_LINKED', 'SOURCE_NOT_FOUND', 'IDENTITY_CHANGED'].includes(status);
}
