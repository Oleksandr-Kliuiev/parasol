import { lazy, Suspense, useState } from 'react';
import { Button, Spinner, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import type { Activity } from './types';

const TaskTicketContent = lazy(() => import('./TaskTicketContent'));

/** Shared by exact selections and ordinary timeline rows, with no eager per-row requests. */
export function TaskTicketButton({ activity }: { activity: Activity }) {
  const user = useCurrentUser(); const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const [open, setOpen] = useState(false);
  if (activity.type !== 'Task' || !user.permissions.includes(Permissions.activitiesRead) || !user.permissions.includes(Permissions.serviceRead)) return null;
  const scope = JSON.stringify([user.id, [...user.permissions].sort(), activity.organizationId, activity.id]);
  return <>
    <Button {...restore} size="small" appearance="subtle" aria-label={t('taskTicket.openNamed', { subject: activity.subject })}
      onClick={() => setOpen(true)}>{t('taskTicket.open')}</Button>
    {open && <Suspense fallback={<Spinner size="small" label={t('common.loading')} />}><TaskTicketContent key={scope} activity={activity} scope={scope} onClose={() => setOpen(false)}
        canWrite={user.permissions.includes(Permissions.activitiesWrite)}
        canLogTime={user.permissions.includes(Permissions.timeOwn) || user.permissions.includes(Permissions.timeManage)} /></Suspense>}
  </>;
}

