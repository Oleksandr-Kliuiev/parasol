import type { ObservationTaskPreview, TechnicalTaskRef } from '../features/parasol/observationTaskContract';
import { atlasWorkspace } from './atlasWorkspace';

export const syntheticTask: TechnicalTaskRef = {
  activityId: 'task-one', organizationId: 'customer-one', status: 'Open', assigneeId: 'u2', dueAt: null, created: false, isAvailable: true,
};
export function atlasTaskPreview(): ObservationTaskPreview {
  const summary = atlasWorkspace().summary!;
  return { customerId: 'customer-one', status: 'READY', mode: 'db', observation: summary.observationPage.items[0]!,
    devices: summary.devices, sha256: 'a'.repeat(64), task: null, canCreate: true };
}
