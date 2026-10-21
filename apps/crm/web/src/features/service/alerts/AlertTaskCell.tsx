import { useRef, useState } from 'react';
import { Button, useRestoreFocusTarget } from '@fluentui/react-components';
import { PersonAdd16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { Alert } from '../types';
import { AlertTaskSummary } from './AlertTaskBits';
import { AlertTaskDialog } from './AlertTaskDialog';
import { useAlertTaskAccess, type AlertTask } from './alertTasks';

/**
 * The task column of an alert row: the task it has (from the page's one lookup), or Assign for an open alert. A task the dialog
 * made shows at once, before the page's lookup is read again.
 */
export function AlertTaskCell({ alert, task }: { alert: Pick<Alert, 'id' | 'title' | 'state'>; task: AlertTask | undefined }) {
  const { t } = useTranslation(); const { read, write, user } = useAlertTaskAccess(); const restore = useRestoreFocusTarget();
  const [open, setOpen] = useState(false); const [made, setMade] = useState<AlertTask | null>(null);
  const holder = useRef<HTMLSpanElement>(null);
  if (!read) return null;
  const shown = task ?? made;
  const close = () => {
    setOpen(false);
    // The Assign button is gone once the task exists: focus moves to the task that replaced it, not to the page.
    if (made) queueMicrotask(() => holder.current?.querySelector<HTMLElement>('a')?.focus());
  };
  return <span ref={holder}>
    {shown ? <AlertTaskSummary task={shown} compact />
      : write && alert.state !== 'Resolved' && <Button {...restore} size="small" icon={<PersonAdd16Regular />}
        aria-label={t('alerts.task.assignNamed', { title: alert.title })} onClick={() => setOpen(true)}>{t('alerts.task.assign')}</Button>}
    {open && <AlertTaskDialog key={`${user.id}:${alert.id}`} alertId={alert.id} onClose={close} onTask={setMade} />}
  </span>;
}
