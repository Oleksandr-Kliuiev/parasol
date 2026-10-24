import { useId, useRef, useState } from 'react';
import { Button, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { PersonAdd20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import type { Alert } from '../types';
import { AlertTaskSummary } from './AlertTaskBits';
import { AlertTaskDialog } from './AlertTaskDialog';
import { useAlertTaskAccess, useAlertTaskLinks, type AlertTask } from './alertTasks';

const useStyles = makeStyles({
  title: { margin: 0, marginBottom: '8px', color: h.muted, fontSize: '12.5px', fontWeight: 600, ':focus-visible': { outlineOffset: '2px' } },
  muted: { color: h.muted },
});

/** The task part of an alert's side panel: the task it has, or the panel's one primary action, Assign. */
export function AlertTaskSection({ alert, onNavigate }: { alert: Alert; onNavigate?: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const { read, write } = useAlertTaskAccess();
  const restore = useRestoreFocusTarget(); const heading = useId(); const headingRef = useRef<HTMLHeadingElement>(null);
  const links = useAlertTaskLinks([[alert.id]]);
  const [assigning, setAssigning] = useState(false); const [made, setMade] = useState<AlertTask | null>(null);
  if (!read) return null;
  const task = links.links.get(alert.id) ?? made;
  const close = () => {
    setAssigning(false);
    // Assign is gone once the task exists: focus moves to the section that now names it, not out of the panel.
    if (made) queueMicrotask(() => headingRef.current?.focus());
  };
  return <section aria-labelledby={heading}>
    <h3 id={heading} ref={headingRef} tabIndex={-1} className={styles.title}>{t('alerts.detail.task')}</h3>
    {links.loading ? <Spinner size="tiny" label={t('common.loading')} />
      : task ? <AlertTaskSummary task={task} onNavigate={onNavigate} />
      : write && alert.state !== 'Resolved' ? <Button {...restore} appearance="primary" icon={<PersonAdd20Regular />} onClick={() => setAssigning(true)}>
        {t('alerts.task.assign')}</Button>
      : <Text block className={styles.muted}>{t(alert.state === 'Resolved' ? 'alerts.detail.noTaskResolved' : 'alerts.dialog.cannotCreate')}</Text>}
    {assigning && <AlertTaskDialog alertId={alert.id} onClose={close} onTask={setMade} />}
  </section>;
}
