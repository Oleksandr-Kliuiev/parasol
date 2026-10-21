import { useImperativeHandle, useState, type Ref } from 'react';
import { Button, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import type { ObservationTaskLink } from './observationTaskContract';
import type { AtlasObservation } from './technicalContract';
import { ObservationTaskDialog } from './ObservationTaskDialog';

export interface ObservationWorkControls { open: (assignToMe?: boolean) => void }

/**
 * `linked`: the row already knows of a task for the observation, so the button opens it to look, not to assign. `onTask`
 * hears of the task the dialog made or found, so the row can say so before any list reads it again.
 */
export function ObservationWorkButton({ customerId, observationId, status, onSourceInvalidated, linked = false, onTask, controls }: {
  customerId: string; observationId: string; status: AtlasObservation['status']; onSourceInvalidated?: () => void; linked?: boolean;
  onTask?: (link: ObservationTaskLink) => void;
  /** For a list that opens the work from the keyboard (the queue's Enter and A keys). */
  controls?: Ref<ObservationWorkControls>;
}) {
  const { t } = useTranslation(); const user = useCurrentUser();
  // The dialog keeps the purpose it was opened for: the task it makes turns the row "linked" while its receipt is still shown.
  const [openedToAssign, setOpenedToAssign] = useState<boolean | null>(null);
  const [toMe, setToMe] = useState(false);
  const canWrite = useCan(Permissions.activitiesWrite); const canRead = useCan(Permissions.activitiesRead);
  const canAtlas = useCan(Permissions.parasolAtlasRead); const restoreFocus = useRestoreFocusTarget();
  const active = status === 'OPEN' || status === 'ACKNOWLEDGED';
  const allowCreate = active && canWrite && !linked;
  useImperativeHandle(controls, () => ({ open: (assignToMe = false) => { setToMe(assignToMe && allowCreate); setOpenedToAssign(allowCreate); } }), [allowCreate]);
  if (!canAtlas || !canRead) return null;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <>
    <Button {...restoreFocus} size="small" onClick={() => { setToMe(false); setOpenedToAssign(allowCreate); }}>{t(allowCreate ? 'parasolWork.assign' : active && !linked ? 'parasolWork.viewWork' : 'parasolWork.viewLinked')}</Button>
    {openedToAssign !== null && <ObservationTaskDialog key={`${user.id}:${permissionsKey}:${customerId}:${observationId}`} customerId={customerId} observationId={observationId}
      allowCreate={openedToAssign && active && canWrite} assignToMe={toMe} onClose={() => setOpenedToAssign(null)} onSourceInvalidated={onSourceInvalidated} onTask={onTask} />}
  </>;
}
