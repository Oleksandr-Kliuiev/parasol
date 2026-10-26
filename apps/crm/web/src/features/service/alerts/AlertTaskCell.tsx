import { Button, useRestoreFocusTarget } from '@fluentui/react-components';
import { PersonAdd16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { alertTitle } from './alertText';
import type { Alert } from '../types';
import { AlertTaskSummary } from './AlertTaskBits';
import { useAlertTaskDialogs } from './alertTaskDialogs';
import { useAlertTaskAccess, type AlertTask } from './alertTasks';

/**
 * The task column of an alert row: the task it has (from the page's one lookup), or Assign for an open alert. A task the dialog
 * made shows at once, before the page's lookup is read again. The dialog itself lives in the list's AlertTaskDialogHost.
 */
export function AlertTaskCell({ alert, task }: { alert: Pick<Alert, 'id' | 'title' | 'state'>; task: AlertTask | undefined }) {
  const { t } = useTranslation(); const { read, write } = useAlertTaskAccess(); const restore = useRestoreFocusTarget();
  const dialogs = useAlertTaskDialogs();
  if (!read) return null;
  const shown = task ?? dialogs.made.get(alert.id);
  return <span data-alert-task={alert.id}>
    {shown ? <AlertTaskSummary task={shown} compact />
      : write && alert.state !== 'Resolved' && <Button {...restore} size="small" icon={<PersonAdd16Regular />}
        aria-label={t('alerts.task.assignNamed', { title: alertTitle(t, alert) })} onClick={() => dialogs.open(alert.id)}>{t('alerts.task.assign')}</Button>}
  </span>;
}
