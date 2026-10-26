import { useEffect, useId, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Spinner, Text,
  ToggleButton, makeStyles,
} from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import type { UserRef } from '../../../api/types';
import { h } from '../../../app/hearth';
import { currentUserQueryKey } from '../../../auth/CurrentUserContext';
import { Dialog } from '../../../shared/components/Dialog';
import { UserPicker } from '../../../shared/components/UserPicker';
import { formatDateTime } from '../../../shared/utils/format';
import { activityKeys } from '../../activities/api';
import { useDialogStyles } from '../../contracts/dialogStyles';
import { AlertAge, AlertSeverityBadge } from './AlertBits';
import { AlertReadError, AlertTaskSummary } from './AlertTaskBits';
import { createAlertTask, useAlertTaskAccess, useAlertTaskPreview, type AlertTask, type AlertTaskOutcome } from './alertTasks';
import { sourceName } from './alertText';
import { dueIn, dueIso, dueShortcuts } from './dueDates';

const subjectLength = 256;

// One rhythm top to bottom: the alert as read now, then what the task will hold, then who and when, then what the button does.
const useLayout = makeStyles({
  content: { display: 'grid', gap: '14px', alignContent: 'start' },
  alert: {
    display: 'grid', gap: '4px', paddingTop: '10px', paddingBottom: '10px', paddingLeft: '12px', paddingRight: '12px',
    borderRadius: '12px', border: `1px solid ${h.line}`, backgroundColor: h.surface2,
  },
  alertHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' },
  alertTitle: { fontWeight: 600, overflowWrap: 'anywhere' },
  meta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere' },
  // Short cuts under a field: one tap for the usual answers, the field stays the place to type anything else.
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' },
  // What the button will create, said in one sentence beside it.
  summary: { gridColumn: '1 / -1', color: h.text, fontSize: '13.5px', lineHeight: '20px', fontWeight: 600 },
  priority: { gridColumn: '1 / -1', color: h.muted, fontSize: '13px', lineHeight: '19px' },
});

type Issue = 'changed' | 'resolved' | 'assignee' | 'customerChanged' | 'uncertain' | 'refused';

/**
 * Assign an alert as a task (M38). The dialog reads the alert now; the create names the fingerprint of exactly that read, so an
 * alert that changed meanwhile is shown again instead of assigned unseen. A task the alert already has, a colleague's too, is
 * shown instead of a second one.
 */
export function AlertTaskDialog({ alertId, onClose, onTask }: {
  alertId: string; onClose: () => void;
  /** Hears of the task the dialog made or found, so the row can say so before its list is read again. */
  onTask?: (task: AlertTask) => void;
}) {
  const { t } = useTranslation(); const styles = useDialogStyles(); const layout = useLayout(); const client = useQueryClient();
  const { write, user } = useAlertTaskAccess(); const summaryId = useId();
  const me: UserRef = { id: user.id, displayName: user.displayName };
  const preview = useAlertTaskPreview(alertId);
  const [assignee, setAssignee] = useState<UserRef | null>(write ? me : null);
  // The picker keeps the text it shows; choosing "me" outside it starts it again with the new name.
  const [pickerRevision, setPickerRevision] = useState(0);
  // Null follows the alert's title as last read; typing keeps the employee's words through a fresh read.
  const [subject, setSubject] = useState<string | null>(null);
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AlertTaskOutcome | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ subject?: string; assignee?: string }>({});
  const active = useRef(true); const submitting = useRef(false); const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // Once the task exists the create button is gone: focus goes to Close, the way out, never to the page behind.
  useEffect(() => { if (outcome) closeButton.current?.focus(); }, [outcome]);

  const view = !preview.isFetching ? preview.data : undefined;
  const task = outcome?.task ?? view?.task ?? null;
  const text = subject ?? view?.subject ?? '';
  const invalidDue = dueAt !== '' && dueIso(dueAt) === null;
  const canCreate = write && view?.canCreate === true && !task && !outcome && assignee !== null && !invalidDue && !busy;
  const now = new Date();

  const readAgain = () => { setIssue(null); setFieldErrors({}); void preview.refetch(); };
  const create = async () => {
    if (!canCreate || !view || !assignee || submitting.current) return;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > subjectLength) {
      setFieldErrors({ subject: t(trimmed ? 'alerts.dialog.subjectTooLong' : 'alerts.dialog.subjectRequired') });
      return;
    }
    submitting.current = true; setBusy(true); setIssue(null); setFieldErrors({});
    try {
      const result = await createAlertTask({ alertId, assigneeId: assignee.id, dueAt: dueIso(dueAt), subject: trimmed, expectedFingerprint: view.fingerprint });
      void client.invalidateQueries({ queryKey: activityKeys.all });
      void client.invalidateQueries({ queryKey: currentUserQueryKey });
      onTask?.(result.task);
      if (active.current) setOutcome(result);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const next: Issue = code === 'ACT_SOURCE_ALERT_CHANGED' ? 'changed' : code === 'ACT_SOURCE_ALERT_RESOLVED' ? 'resolved'
        : code === 'ACT_SOURCE_TASK_ASSIGNEE_INVALID' ? 'assignee' : code === 'ACT_SOURCE_TASK_CUSTOMER_CHANGED' ? 'customerChanged'
        : error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'refused' : 'uncertain';
      // An answer that never came may still have made the task: never offer the button again before a fresh read.
      if (next === 'uncertain') void client.invalidateQueries({ queryKey: activityKeys.all });
      if (!active.current) return;
      if (next === 'assignee') setFieldErrors({ assignee: t('alerts.dialog.assigneeInvalid') });
      else if (next === 'refused' && error instanceof ApiError && Object.keys(error.fieldErrors).length > 0) {
        setFieldErrors({
          subject: error.fieldErrors.subject ? t('alerts.dialog.subjectInvalid') : undefined,
          assignee: error.fieldErrors.assigneeId ? t('alerts.dialog.assigneeRequired') : undefined,
        });
      } else setIssue(next);
      if (next === 'changed' || next === 'resolved' || next === 'uncertain' || next === 'customerChanged') void preview.refetch();
    } finally {
      submitting.current = false; if (active.current) setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('alerts.dialog.title')}</DialogTitle>
      <DialogContent className={layout.content}>
        {preview.isFetching && <Spinner size="small" label={t('alerts.detail.loading')} />}
        {!preview.isFetching && preview.isError && <AlertReadError error={preview.error} onRetry={readAgain} />}
        {issue && <MessageBar intent="warning" className={styles.error}><MessageBarBody>
          <Text role="status">{t(`alerts.dialog.${issue}`)}</Text>
        </MessageBarBody></MessageBar>}
        {view && <div className={layout.alert}>
          <span className={layout.alertHead}>
            <AlertSeverityBadge severity={view.alert.severity} />
            <Text className={layout.alertTitle}>{view.alert.title}</Text>
          </span>
          <Text className={layout.meta}>
            {[view.alert.organizationName, view.alert.deviceName, t('alerts.source', { name: sourceName(t, view.alert.system) })].filter(Boolean).join(' · ')}
            {' · '}<AlertAge at={view.alert.createdAt} />
            {view.alert.state === 'Resolved' && ` · ${t('alerts.states.Resolved')}`}
          </Text>
        </div>}
        {outcome && <Text block role="status" weight="semibold">{t(outcome.status === 'CREATED' ? 'alerts.dialog.created' : 'alerts.dialog.existing')}</Text>}
        {!outcome && task && <Text block role="status">{t('alerts.dialog.hasTask')}</Text>}
        {task && <AlertTaskSummary task={task} onNavigate={onClose} />}
        {view && !task && !view.canCreate && <Text block>{t(view.alert.state === 'Resolved' ? 'alerts.dialog.resolved' : 'alerts.dialog.cannotCreate')}</Text>}
        {view && !task && view.canCreate && !outcome && <div className={styles.grid}>
          <Field className={styles.wide} required label={t('alerts.dialog.subject')} hint={t('alerts.dialog.subjectHint')}
            validationMessage={fieldErrors.subject}>
            <Input value={text} maxLength={subjectLength} disabled={busy}
              onChange={(_, d) => { setSubject(d.value); setFieldErrors((errors) => ({ ...errors, subject: undefined })); }} />
          </Field>
          <div>
            <Field required label={t('alerts.dialog.assignee')} validationMessage={fieldErrors.assignee}>
              <UserPicker key={pickerRevision} value={assignee} disabled={busy}
                onChange={(next) => { setAssignee(next); setFieldErrors((errors) => ({ ...errors, assignee: undefined })); }} />
            </Field>
            <div className={layout.shortcuts}>
              <ToggleButton size="small" shape="circular" checked={assignee?.id === me.id} disabled={busy}
                onClick={() => { setAssignee(me); setPickerRevision((r) => r + 1); setFieldErrors((errors) => ({ ...errors, assignee: undefined })); }}>
                {t('alerts.dialog.assignToMe')}</ToggleButton>
            </div>
          </div>
          <div>
            <Field label={t('alerts.dialog.due')} validationMessage={invalidDue ? t('alerts.dialog.invalidDue') : undefined}>
              <Input type="datetime-local" value={dueAt} disabled={busy} onChange={(_, d) => setDueAt(d.value)} />
            </Field>
            <div role="group" aria-label={t('alerts.dialog.dueShortcuts')} className={layout.shortcuts}>
              {dueShortcuts.map(([key, days]) => {
                const value = dueIn(days, now);
                return <ToggleButton key={key} size="small" shape="circular" checked={dueAt === value}
                  // Today at 16:00 has passed in the evening: it would be due already.
                  disabled={busy || new Date(value).getTime() <= now.getTime()} onClick={() => setDueAt(value)}>{t(`alerts.dialog.dueIn.${key}`)}</ToggleButton>;
              })}
              <ToggleButton size="small" shape="circular" checked={dueAt === ''} disabled={busy} onClick={() => setDueAt('')}>{t('alerts.dialog.dueIn.none')}</ToggleButton>
            </div>
          </div>
          <Text block className={layout.priority}>{t(`alerts.dialog.priorityFrom.${view.alert.severity}`)}</Text>
          {assignee && !invalidDue && <Text block id={summaryId} className={layout.summary}>
            {t(dueAt ? 'alerts.dialog.summaryDue' : 'alerts.dialog.summaryNoDue', {
              name: assignee.displayName, due: dueAt ? formatDateTime(dueIso(dueAt) ?? '') : '',
            })}
          </Text>}
        </div>}
      </DialogContent>
      <DialogActions>
        <Button ref={closeButton} disabled={busy} onClick={onClose}>{t('common.close')}</Button>
        {(issue || preview.isError) && <Button disabled={busy || preview.isFetching} onClick={readAgain}>{t('alerts.dialog.readAgain')}</Button>}
        {view?.canCreate && !task && !outcome && <Button appearance="primary" disabled={!canCreate} disabledFocusable={busy}
          aria-describedby={canCreate ? summaryId : undefined} onClick={() => void create()}>
          {busy ? t('alerts.dialog.creating') : t('alerts.dialog.create')}</Button>}
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
