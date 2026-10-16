import { useState } from 'react';
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
      <DialogSurface>{open && <ActivityForm onClose={onClose} {...props} />}</DialogSurface>
    </Dialog>
  );
}

function ActivityForm({ organizationId, opportunityId, contractId, activity, defaultType, onClose }: Omit<ActivityDialogProps, 'open'>) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useActivityActions();
  const [type, setType] = useState<ActivityType>(activity?.type ?? defaultType ?? 'Task');
  const [subject, setSubject] = useState(activity?.subject ?? '');
  const [body, setBody] = useState(activity?.body ?? '');
  const [dueAt, setDueAt] = useState(activity?.dueAt ? activity.dueAt.slice(0, 16) : '');
  const [priority, setPriority] = useState<ActivityPriority>(activity?.priority ?? 'Normal');
  const [assignee, setAssignee] = useState<UserRef | null>(activity?.assignee ? { id: activity.assignee.id, displayName: activity.assignee.name } : null);
  const [duration, setDuration] = useState(String(activity?.durationMinutes ?? 60));
  const [location, setLocation] = useState(activity?.location ?? '');
  const [addToCalendar, setAddToCalendar] = useState(activity?.inCalendar ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const outlook = useOutlookStatus();
  const needsDue = type === 'Meeting';
  const mutation = activity ? actions.update : actions.create;
  const invalid = !subject.trim() || (needsDue && !dueAt);

  const submit = async () => {
    if (invalid) return;
    const request = {
      type,
      organizationId,
      opportunityId: opportunityId ?? activity?.opportunityId ?? null,
      contractId: contractId ?? activity?.contractId ?? null,
      contactId: activity?.contactId ?? null,
      subject: subject.trim(),
      body: blankToNull(body),
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      priority,
      assigneeId: assignee?.id ?? null,
      durationMinutes: type === 'Meeting' ? Number(duration) || 60 : null,
      location: type === 'Meeting' ? blankToNull(location) : null,
      addToCalendar: type === 'Meeting' && addToCalendar,
    };
    try {
      if (activity) await actions.update.mutateAsync({ id: activity.id, request, etag: activity.etag });
      else await actions.create.mutateAsync(request);
      notify(activity ? t('activities.saved') : t('activities.logged'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{activity ? t('activities.editTitle') : t('activities.newTitle')}</DialogTitle>
        <DialogContent>
          {mutation.error && !(mutation.error instanceof ApiError && mutation.error.status === 400) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('activities.fields.type')} required>
              <Dropdown disabled={activity?.hasTechnicalSource} value={t(`activities.types.${type}`)} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue as ActivityType)}>
                {activityTypes.filter((value) => value !== 'Email').map((value) => (
                  <Option key={value} value={value}>
                    {t(`activities.types.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('activities.fields.priority')}>
              <Dropdown value={t(`activities.priorities.${priority}`)} selectedOptions={[priority]} onOptionSelect={(_, d) => setPriority(d.optionValue as ActivityPriority)}>
                {activityPriorities.map((value) => (
                  <Option key={value} value={value}>
                    {t(`activities.priorities.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('activities.fields.subject')} required className={styles.wide} validationMessage={errors.subject}>
              <Input value={subject} onChange={(_, d) => setSubject(d.value)} />
            </Field>
            {(type === 'Task' || type === 'Meeting') && (
              <>
                <Field label={type === 'Meeting' ? t('activities.fields.startsAt') : t('activities.fields.dueAt')} required={needsDue} validationMessage={errors.dueAt}>
                  <Input type="datetime-local" value={dueAt} onChange={(_, d) => setDueAt(d.value)} />
                </Field>
                <Field label={t('activities.fields.assignee')}>
                  <UserPicker value={assignee} onChange={setAssignee} />
                </Field>
              </>
            )}
            {type === 'Meeting' && (
              <>
                <Field label={t('activities.fields.duration')} validationMessage={errors.durationMinutes}>
                  <Input type="number" min={5} max={1440} step={15} value={duration} onChange={(_, d) => setDuration(d.value)} />
                </Field>
                <Field label={t('activities.fields.location')} validationMessage={errors.location}>
                  <Input value={location} onChange={(_, d) => setLocation(d.value)} />
                </Field>
                <div className={styles.wide}>
                  <Switch
                    label={t('activities.addToCalendar')}
                    checked={addToCalendar}
                    disabled={!outlook.data?.calendar}
                    onChange={(_, d) => setAddToCalendar(Boolean(d.checked))}
                  />
                  {!outlook.data?.calendar && <MessageBar intent="info"><MessageBarBody>{t('activities.calendarOff')}</MessageBarBody></MessageBar>}
                </div>
              </>
            )}
            <Field label={t('activities.fields.body')} className={styles.wide} validationMessage={errors.body}>
              <Textarea value={body} onChange={(_, d) => setBody(d.value)} resize="vertical" />
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
