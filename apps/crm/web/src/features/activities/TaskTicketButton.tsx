import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import type { Activity } from './types';

const TaskTicketContent = lazy(() => import('./TaskTicketContent'));

/** Shared by exact selections and ordinary timeline rows, with no eager per-row requests. */
export function TaskTicketButton({ activity, onCloseAfterChange }: { activity: Activity; onCloseAfterChange?: () => void }) {
  const user = useCurrentUser(); const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const [open, setOpen] = useState(false);
  const changedScope = useRef<string | null>(null);
  const closedChange = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = JSON.stringify([user.id, [...user.permissions].sort(), activity.organizationId, activity.id]);
  const restored = useCallback(() => {
    if (open || closedChange.current !== scope) return;
    closedChange.current = null;
    const owner = trigger.current;
    // Let Fluent finish restoring focus before a parent read removes/replaces this row.
    queueMicrotask(() => { if (owner?.isConnected) onCloseAfterChange?.(); });
  }, [open, scope, onCloseAfterChange]);
  useEffect(() => {
    if (open || closedChange.current !== scope) return;
    const owner = trigger.current; const document = owner?.ownerDocument;
    const active = document?.activeElement;
    if (owner?.isConnected && (active === document?.body || active === owner || active?.closest('[role="dialog"]'))) {
      owner.focus();
      if (document?.activeElement === owner) restored();
    }
  }, [open, scope, restored]);
  if (activity.type !== 'Task' || !user.permissions.includes(Permissions.activitiesRead) || !user.permissions.includes(Permissions.serviceRead)) return null;
  const close = () => {
    closedChange.current = changedScope.current === scope ? scope : null;
    changedScope.current = null; setOpen(false);
  };
  return <>
    <Button {...restore} ref={trigger} onFocus={restored} size="small" appearance="subtle" aria-label={t('taskTicket.openNamed', { subject: activity.subject })}
      onClick={() => setOpen(true)}>{t('taskTicket.open')}</Button>
    {open && <Suspense fallback={<Spinner size="small" label={t('common.loading')} />}><TaskTicketContent key={scope} activity={activity} scope={scope} onClose={close}
        onAssociationSaved={() => { changedScope.current = scope; }}
        canWrite={user.permissions.includes(Permissions.activitiesWrite)}
        canLogTime={user.permissions.includes(Permissions.timeOwn) || user.permissions.includes(Permissions.timeManage)} /></Suspense>}
  </>;
}

