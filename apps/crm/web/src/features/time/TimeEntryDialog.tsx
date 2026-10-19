import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Combobox,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Textarea,
  Text,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDialogStyles } from '../contracts/dialogStyles';
import { TimeOrganizationPicker } from './TimeOrganizationPicker';
import type { Ref } from '../contracts/types';
import { timeKeys } from './api';
import { useTimeFormOptions } from './useTimeFormOptions';
import type { TicketWorkRef } from '../activities/taskTicketTypes';
import type { TimeEntry } from './types';

export interface TaskTimeContext { activityId: string; organization: Ref; ticket: TicketWorkRef }
interface TimeEntryDialogProps { entry?: TimeEntry; defaultDate?: string; taskContext?: TaskTimeContext; onClose: () => void }

/** Registers or edits manual CRM hours; task context never determines the hours author. */
export function TimeEntryDialog(props: TimeEntryDialogProps) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.timeOwn) && !user.permissions.includes(Permissions.timeManage)) return null;
  if (props.taskContext && (!user.permissions.includes(Permissions.activitiesRead) || !user.permissions.includes(Permissions.serviceRead))) return null;
  const scope = JSON.stringify([user.id, [...user.permissions].sort(), props.entry?.id, props.entry?.etag, props.defaultDate, props.taskContext]);
  return <TimeEntryForm key={scope} {...props} scope={scope} />;
}

function TimeEntryForm({ entry, defaultDate, taskContext, onClose, scope }: TimeEntryDialogProps & { scope: string }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const client = useQueryClient(); const alive = useRef(false); const submitting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [pending, setPending] = useState(false); const [failure, setFailure] = useState<unknown>(null);
  const [clientRequestId] = useState(() => entry ? null : crypto.randomUUID());
  const hoursInput = useRef<HTMLInputElement>(null); const fromTask = Boolean(taskContext);
  useEffect(() => { if (fromTask) hoursInput.current?.focus(); }, [fromTask]);
  const [organization, setOrganization] = useState<Ref | null>(
    taskContext?.organization ?? (entry ? { id: entry.organizationId, name: entry.organizationName ?? '' } : null),
  );
  const [workDate, setWorkDate] = useState(entry?.workDate ?? defaultDate ?? todayIso());
  const [hours, setHours] = useState(entry ? String(entry.hours) : taskContext ? '' : '1');
  const [workType, setWorkType] = useState(entry?.workType ?? '');
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [onsite, setOnsite] = useState(entry?.onsite ?? false);
  const [afterHours, setAfterHours] = useState(entry?.afterHours ?? false);
  const [description, setDescription] = useState(entry?.description ?? '');
  const [ticket, setTicket] = useState(taskContext ? String(taskContext.ticket.externalId) : entry?.externalTicketId ? String(entry.externalTicketId) : '');
  const [ticketId, setTicketId] = useState(taskContext?.ticket.id ?? entry?.ticketId ?? null);
  const [sourceActivityId, setSourceActivityId] = useState(taskContext?.activityId ?? entry?.sourceActivityId ?? null);
  const [ticketTitle, setTicketTitle] = useState(taskContext?.ticket.title ?? entry?.ticketTitle ?? null);
  const [projectId, setProjectId] = useState(entry?.projectId ?? '');
  // Only the customer's own open projects can take hours; the list is empty until a customer is picked.
  const { workTypes, projects: projectOptions } = useTimeFormOptions(scope, organization?.id);
  const projects = projectOptions.isSuccess && !projectOptions.isFetching ? projectOptions.data : [];

  const [errors, setErrors] = useState<Record<string, string>>({});
  const hoursValue = parseDecimal(hours);
  const ticketValue = ticket.trim() === '' ? null : Number(ticket.trim());
  const invalid = !organization || hoursValue === null || Number.isNaN(hoursValue) || hoursValue <= 0 || hoursValue > 24
    || (ticketValue !== null && (!Number.isSafeInteger(ticketValue) || ticketValue <= 0)) || Boolean(taskContext && !description.trim());

  const clearTicketContext = () => { setTicketId(null); setSourceActivityId(null); setTicketTitle(null); };
  const changeOrganization = (value: Ref | null) => {
    if (value?.id !== organization?.id) { clearTicketContext(); setTicket(''); setProjectId(''); }
    setOrganization(value);
  };

  const submit = async () => {
    if (invalid || submitting.current) return;
    submitting.current = true; setPending(true); setFailure(null); setErrors({});
    const request = {
      organizationId: organization.id,
      technicianId: entry?.technicianId ?? null,
      workDate,
      hours: hoursValue,
      workType: blankToNull(workType),
      billable,
      onsite,
      afterHours,
      description: blankToNull(description),
      externalTicketId: ticketValue,
      ticketTitle,
      projectId: projectId === '' ? null : projectId,
      ticketId,
      sourceActivityId,
      ...(!entry ? { clientRequestId } : {}),
    };
    try {
      if (entry) await api.put(`/api/v1/time/entries/${entry.id}`, request, entry.etag);
      else await api.post('/api/v1/time/entries', request);
      if (!alive.current) return;
      void client.invalidateQueries({ queryKey: timeKeys.all });
      notify(entry ? t('time.saved') : t('time.registered'));
      onClose();
    } catch (error) {
      if (alive.current) {
        setFailure(error);
        if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
      }
    } finally {
      submitting.current = false;
      if (alive.current) setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{entry ? t('time.editEntry') : t('time.newEntry')}</DialogTitle>
        <DialogContent>
          {taskContext && <Text block>{t('taskTicket.timeHint')}</Text>}
          {failure && (!(failure instanceof ApiError && failure.status === 400) || Object.keys(errors).length === 0) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(failure, t)}</MessageBarBody>
            </MessageBar>
          )}
          <fieldset disabled={pending} className={styles.grid} style={{ border: 0, margin: 0, padding: 0 }}>
            <Field label={t('time.fields.organization')} required className={styles.wide} validationMessage={errors.organizationId}>
              {taskContext ? <Input value={taskContext.organization.name} readOnly /> : <TimeOrganizationPicker value={organization} onChange={changeOrganization} scope={scope} disabled={pending} />}
            </Field>
            <Field label={t('time.fields.workDate')} required validationMessage={errors.workDate}>
              <Input type="date" value={workDate} onChange={(_, d) => setWorkDate(d.value)} />
            </Field>
            <Field label={t('time.fields.hours')} required validationMessage={errors.hours}>
              <Input ref={hoursInput} inputMode="decimal" value={hours} onChange={(_, d) => setHours(d.value)} contentAfter={t('contracts.hoursShort')} />
            </Field>
            <Field label={t('time.fields.workType')}>
              <Combobox
                freeform
                value={workType}
                selectedOptions={workType ? [workType] : []}
                onInput={(event) => setWorkType((event.target as HTMLInputElement).value)}
                onOptionSelect={(_, d) => setWorkType(d.optionValue ?? '')}
              >
                {(workTypes.isSuccess && !workTypes.isFetching ? workTypes.data : []).map((type) => (
                  <Option key={type} value={type}>
                    {type}
                  </Option>
                ))}
              </Combobox>
            </Field>
            {/* FR-PRJ-01: hours on an implementation project are booked to it, so plan against actual stays honest. */}
            <Field label={t('time.fields.project')} hint={projectOptions.isFetching ? t('common.loading') : projectOptions.isSuccess && projects.length === 0 ? t('time.noProjects') : undefined}>
              <Dropdown
                disabled={projects.length === 0 || !projectOptions.isSuccess || projectOptions.isFetching || pending}
                value={projects.find((p) => p.id === projectId)?.name ?? t('time.noProject')}
                selectedOptions={[projectId]}
                onOptionSelect={(_, d) => setProjectId(d.optionValue ?? '')}
              >
                <Option value="">{t('time.noProject')}</Option>
                {projects.map((project) => (
                  <Option key={project.id} value={project.id}>
                    {project.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('time.fields.ticket')} hint={t(ticketId && !taskContext ? 'taskTicket.savedEntryHint' : 'time.ticketHint')} validationMessage={errors.externalTicketId}>
              <Input inputMode="numeric" value={taskContext ? `#${ticket} · ${taskContext.ticket.title}` : ticket} readOnly={Boolean(taskContext)}
                onChange={(_, d) => { clearTicketContext(); setTicket(d.value); }} />
              {ticketId && !taskContext && <Button size="small" onClick={clearTicketContext}>{t('taskTicket.useManual')}</Button>}
            </Field>
            <Switch label={t('time.fields.billable')} checked={billable} onChange={(_, d) => setBillable(d.checked)} />
            <Switch label={t('time.fields.onsite')} checked={onsite} onChange={(_, d) => setOnsite(d.checked)} />
            <Switch label={t('time.fields.afterHours')} checked={afterHours} onChange={(_, d) => setAfterHours(d.checked)} />
            <Field label={t('time.fields.description')} required={Boolean(taskContext)} className={styles.wide} validationMessage={errors.description}>
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" />
            </Field>
          </fieldset>
          {workTypes.error && <ErrorState error={workTypes.error} onRetry={() => void workTypes.refetch()} />}
          {projectOptions.error && <ErrorState error={projectOptions.error} onRetry={() => void projectOptions.refetch()} />}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || pending} disabledFocusable={pending}>
            {entry ? t('common.save') : t('time.register')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
