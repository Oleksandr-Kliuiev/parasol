import { useState } from 'react';
import { Button, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import type { AtlasObservation } from './technicalContract';
import { ObservationTaskDialog } from './ObservationTaskDialog';

export function ObservationWorkButton({ customerId, observationId, status, onSourceInvalidated }: {
  customerId: string; observationId: string; status: AtlasObservation['status']; onSourceInvalidated?: () => void;
}) {
  const { t } = useTranslation(); const user = useCurrentUser(); const [open, setOpen] = useState(false);
  const canWrite = useCan(Permissions.activitiesWrite); const canRead = useCan(Permissions.activitiesRead);
  const canAtlas = useCan(Permissions.parasolAtlasRead); const restoreFocus = useRestoreFocusTarget();
  const active = status === 'OPEN' || status === 'ACKNOWLEDGED';
  if (!canAtlas || (active ? !canWrite : !canRead)) return null;
  return <>
    <Button {...restoreFocus} size="small" onClick={() => setOpen(true)}>{t(active ? 'parasolWork.assign' : 'parasolWork.viewLinked')}</Button>
    {open && <ObservationTaskDialog key={`${user.id}:${customerId}:${observationId}`} customerId={customerId} observationId={observationId}
      allowCreate={active && canWrite} onClose={() => setOpen(false)} onSourceInvalidated={onSourceInvalidated} />}
  </>;
}
