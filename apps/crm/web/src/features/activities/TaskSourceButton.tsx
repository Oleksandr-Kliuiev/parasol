import { lazy, Suspense, useRef, useState } from 'react';
import { Button, Spinner, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useAlertTaskAccess } from '../service/alerts/alertTasks';
import type { Activity } from './types';

const TaskSourceDialog = lazy(() => import('./TaskSourceDialog'));

/**
 * The Source button of a task made from an alert (M38): it opens the alert as stored now, never a copy kept with the task. Rows
 * ask nothing until it is pressed; a task of a source the CRM no longer reads has no button (the server says so too).
 */
export function TaskSourceButton({ activity }: { activity: Activity }) {
  const { t } = useTranslation(); const { read, user } = useAlertTaskAccess(); const restore = useRestoreFocusTarget();
  const [open, setOpen] = useState(false); const button = useRef<HTMLButtonElement>(null);
  if (!activity.hasTechnicalSource || activity.type !== 'Task' || !read) return null;
  const close = () => {
    setOpen(false);
    // The dialog comes from a lazy chunk, and WebKit and Firefox then leave focus on the page when it closes: it goes back to
    // the button. A link in the dialog that left the page took the button with it, and focus() on it does nothing.
    requestAnimationFrame(() => { if (document.activeElement === document.body) button.current?.focus(); });
  };
  return <>
    {/* The visible word starts the accessible name (WCAG 2.5.3); the subject tells one row's button from another's. */}
    <Button {...restore} ref={button} size="small" appearance="subtle" aria-label={t('activities.source.openNamed', { subject: activity.subject })}
      onClick={() => setOpen(true)}>{t('activities.source.open')}</Button>
    {open && <Suspense fallback={<Spinner size="small" label={t('common.loading')} />}>
      <TaskSourceDialog key={`${user.id}:${activity.id}`} activityId={activity.id} onClose={close} />
    </Suspense>}
  </>;
}
