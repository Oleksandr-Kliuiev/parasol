import { api } from '../../api/client';
import type { UserRef } from '../../api/types';
import { parseTaskOutcome, parseTaskPreview, type ObservationTaskLink } from './observationTaskContract';
import { taskRoute } from './useObservationTaskPreview';

/** What happened to one observation of a bulk "assign to me". */
export type BulkResult = { outcome: 'CREATED' | 'EXISTING'; link: ObservationTaskLink } | { outcome: 'NOT_CREATED' | 'FAILED' };

/**
 * Assigns one observation to the person the way the dialog does (M12): a fresh exact read first, then a write that carries
 * that read's hash, so a source that changed in between is refused by the server instead of assigned unseen. Nothing is
 * retried; an observation that cannot be assigned is reported, and its own dialog says why.
 */
export async function assignToMe(customerId: string, observationId: string, me: UserRef): Promise<BulkResult> {
  try {
    const route = taskRoute(customerId, observationId);
    const preview = parseTaskPreview((await api.get<unknown>(`${route}/task-preview`)).data, { customerId, observationId });
    if (preview.status === 'READY' && preview.task) return { outcome: 'EXISTING', link: { task: preview.task, assigneeName: null } };
    if (preview.status !== 'READY' || !preview.canCreate || !preview.sha256) return { outcome: 'NOT_CREATED' };
    const result = parseTaskOutcome((await api.post<unknown>(`${route}/task`, {
      assigneeId: me.id, dueAt: null, expectedSha256: preview.sha256,
    })).data, customerId);
    if (result.status === 'INVALID_RESPONSE') return { outcome: 'FAILED' };
    return { outcome: result.status, link: { task: result.task, assigneeName: result.task.assigneeId === me.id ? me.displayName : null } };
  } catch {
    return { outcome: 'FAILED' };
  }
}
