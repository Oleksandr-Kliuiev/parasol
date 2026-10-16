import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Textarea,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull } from '../../shared/utils/format';
import { useDialogStyles } from '../contracts/dialogStyles';
import type { UserRef } from '../../api/types';
import { useActivityActions, useOutlookStatus } from './api';
import { activityPriorities, activityTypes, type Activity, type ActivityPriority, type ActivityType } from './types';
import { activityDueDraft, activityDueValue } from './activityDueDate';

interface ActivityDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  opportunityId?: string | null;
  contractId?: string | null;
  activity?: Activity;
  defaultType?: ActivityType;
}

/** Logs a task, call, meeting or note against a customer (FR-ACT-01). */
export function ActivityDialog({ open, onClose, ...props }: ActivityDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>{open && <ActivityForm key={props.activity?.id ?? 'new'} onClose={onClose} {...props} />}</DialogSurface>
    </Dialog>
  );
}

function ActivityForm({ organizationId, opportunityId, contractId, activity, defaultType, onClose }: Omit<ActivityDialogProps, 'open'>) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useActivityActions();
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [originalEtag] = useState(activity?.etag ?? '');
  const [type, setType] = useState<ActivityType>(activity?.type ?? defaultType ?? 'Task');
  const [subject, setSubject] = useState(activity?.subject ?? '');
  const [body, setBody] = useState(activity?.body ?? '');
  const [initialDue] = useState(() => activityDueDraft(activity?.dueAt));
  const [dueAt, setDueAt] = useState(initialDue.input);
  const [priority, setPriority] = useState<ActivityPriority>(activity?.priority ?? 'Normal');
  const [assignee, setAssignee] = useState<UserRef | null>(activity?.assignee ? { id: activity.assignee.id, displayName: activity.assignee.name } : null);
  const [duration, setDuration] = useState(String(activity?.durationMinutes ?? 60));
  const [location, setLocation] = useState(activity?.location ?? '');
  const [addToCalendar, setAddToCalendar] = useState(activity?.inCalendar ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const outlook = useOutlookStatus();
  const needsDue = type === 'Meeting';
  const mutation = activity ? actions.update : actions.create;
  const invalid = !subject.trim() || (needsDue && !dueAt);

  const submit = async () => {
    if (invalid || mutation.isPending) return;
    setErrors({}); setSaveFailure(null);
    let due: string | null;
    try { due = activityDueValue(dueAt, initialDue); }
    catch { setErrors({ dueAt: t('activities.invalidDue') }); return; }
    const request = {
      type,
      organizationId,
      opportunityId: opportunityId ?? activity?.opportunityId ?? null,
      contractId: contractId ?? activity?.contractId ?? null,
      contactId: activity?.contactId ?? null,
      subject: subject.trim(),
      body: blankToNull(body),
      dueAt: due,
      priority,
      assigneeId: assignee?.id ?? null,
      durationMinutes: type === 'Meeting' ? Number(duration) || 60 : null,
      location: type === 'Meeting' ? blankToNull(location) : null,
      addToCalendar: type === 'Meeting' && addToCalendar,
    };
    try {
      if (activity) await actions.update.mutateAsync({ id: activity.id, request, etag: originalEtag });
      else await actions.create.mutateAsync(request);
      if (!alive.current) return;
      notify(activity ? t('activities.saved') : t('activities.logged'));
      onClose();
    } catch (error) {
      if (!alive.current) return;
      const fields = error instanceof ApiError && error.status === 400 ? error.fieldErrors : {};
      setErrors(fields);
      setSaveFailure(error instanceof ApiError && error.code === 'ACT_SOURCE_TASK_ASSIGNEE_INVALID' ? t('activities.saveSourceAssignee')
        : error instanceof ApiError && (error.status === 409 || error.status === 412) ? t('activities.saveConflict')
        : Object.keys(fields).length ? null
        : error instanceof ApiError && error.status === 400 ? t('activities.saveFailed') : errorMessage(error, t));
    }
  };

  return (
    <form onChangeCapture={() => setSaveFailure(null)} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{activity ? t('activities.editTitle') : t('activities.newTitle')}</DialogTitle>
        <DialogContent>
          {saveFailure && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{saveFailure}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('activities.fields.type')} required>
              <Dropdown disabled={mutation.isPending || activity?.hasTechnicalSource} value={t(`activities.types.${type}`)} selectedOptions={[type]} onOptionSelect={(_, d) => { setType(d.optionValue as ActivityType); setSaveFailure(null); }}>
                {activityTypes.filter((value) => value !== 'Email').map((value) => (
                  <Option key={value} value={value}>
                    {t(`activities.types.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('activities.fields.priority')}>
              <Dropdown disabled={mutation.isPending} value={t(`activities.priorities.${priority}`)} selectedOptions={[priority]} onOptionSelect={(_, d) => { setPriority(d.optionValue as ActivityPriority); setSaveFailure(null); }}>
                {activityPriorities.map((value) => (
                  <Option key={value} value={value}>
                    {t(`activities.priorities.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('activities.fields.subject')} required className={styles.wide} validationMessage={errors.subject}>
              <Input disabled={mutation.isPending} value={subject} onChange={(_, d) => setSubject(d.value)} />
            </Field>
            {(type === 'Task' || type === 'Meeting') && (
              <>
                <Field label={type === 'Meeting' ? t('activities.fields.startsAt') : t('activities.fields.dueAt')} required={needsDue} validationMessage={errors.dueAt}>
                  <Input disabled={mutation.isPending} type="datetime-local" value={dueAt} onChange={(_, d) => setDueAt(d.value)} />
                </Field>
                <Field label={t('activities.fields.assignee')} validationMessage={errors.assigneeId}>
                  <UserPicker disabled={mutation.isPending} value={assignee} onChange={value => { setAssignee(value); setSaveFailure(null); }} />
                </Field>
              </>
            )}
            {type === 'Meeting' && (
              <>
                <Field label={t('activities.fields.duration')} validationMessage={errors.durationMinutes}>
                  <Input disabled={mutation.isPending} type="number" min={5} max={1440} step={15} value={duration} onChange={(_, d) => setDuration(d.value)} />
                </Field>
                <Field label={t('activities.fields.location')} validationMessage={errors.location}>
                  <Input disabled={mutation.isPending} value={location} onChange={(_, d) => setLocation(d.value)} />
                </Field>
                <div className={styles.wide}>
                  <Switch
                    label={t('activities.addToCalendar')}
                    checked={addToCalendar}
                    disabled={mutation.isPending || !outlook.data?.calendar}
                    onChange={(_, d) => setAddToCalendar(Boolean(d.checked))}
                  />
                  {!outlook.data?.calendar && <MessageBar intent="info"><MessageBarBody>{t('activities.calendarOff')}</MessageBarBody></MessageBar>}
                </div>
              </>
            )}
            <Field label={t('activities.fields.body')} className={styles.wide} validationMessage={errors.body}>
              <Textarea disabled={mutation.isPending} value={body} onChange={(_, d) => setBody(d.value)} resize="vertical" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || mutation.isPending}>
            {activity ? t('common.save') : t('activities.log')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
