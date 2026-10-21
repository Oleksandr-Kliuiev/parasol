import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Combobox,
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
  Text,
  Textarea,
  ToggleButton,
  makeStyles,
  mergeClasses,
  tokens,
  useId,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { ActionConfirmation } from '../actions/ActionDialog';
import { useActionAvailable } from '../actions/api';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Dialog } from '../../shared/components/Dialog';
import { ErrorState } from '../../shared/components/ErrorState';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatNumber, todayIso } from '../../shared/utils/format';
import { parseHours, roundHours, typedAsMinutes } from './hours';
import { useDialogStyles } from '../contracts/dialogStyles';
import { TimeOrganizationPicker } from './TimeOrganizationPicker';
import type { Ref } from '../contracts/types';
import { timeKeys } from './api';
import { useTimeFormOptions } from './useTimeFormOptions';
import type { TicketWorkRef } from '../activities/taskTicketTypes';
import type { TimeEntry } from './types';

export interface TaskTimeContext { activityId: string; organization: Ref; ticket: TicketWorkRef }

const useStyles = makeStyles({
  // Two columns down to small phones: date and hours, work type and project are short and belong side by side.
  form: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', '@media (max-width: 359px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  // The three yes/no facts of the work on one row of their own, under the fields and above the description.
  flags: {
    gridColumn: '1 / -1',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '24px',
    rowGap: '4px',
    minHeight: '42px',
  },
  hint: { marginBottom: '12px' },
  // The combobox puts its input in a 1fr grid column: without this the input's own width pushes the chevron out of a
  // narrow column (two columns on a phone).
  comboInput: { minWidth: 0, width: '100%' },
  manual: { alignSelf: 'start', marginTop: '6px' },
  // The Atera step: the checkbox and its hint, the hint in the tone and size of a field's hint.
  record: { gridColumn: '1 / -1', display: 'grid', rowGap: '2px', justifyItems: 'start' },
  recordHint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 },
  // The hours field with its usual durations under it, in the same grid cell.
  hoursCell: { display: 'grid', gap: '8px', minWidth: 0, alignContent: 'start' },
  durations: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
});

/** The durations most entries use: one tap instead of typing a decimal on a phone keyboard. */
const commonDurations = [0.25, 0.5, 0.75, 1, 2] as const;

interface TimeEntryDialogProps {
  entry?: TimeEntry; defaultDate?: string; taskContext?: TaskTimeContext; onClose: () => void;
  /** Hears whether the form holds anything the person typed, so its host can ask before Escape or a click outside drops it. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The registration dialog with its draft protected: Escape or a click beside it closes an untouched form at once, and asks
 * before throwing away what the person typed (the explicit Cancel button still closes without asking).
 */
export function TimeEntryDialogHost({ open, onClose, ...props }: Omit<TimeEntryDialogProps, 'onDirtyChange'> & { open: boolean }) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = () => { setAsking(false); setDirty(false); onClose(); };
  // "Keep editing" puts the person back in the field they left. Focus re-entering the form is also what makes it the
  // active dialog again: without it the form stays hidden from screen readers after the question closes (Chromium).
  const returnTo = useRef<HTMLElement | null>(null);
  const ask = () => { returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setAsking(true); };
  const keepEditing = () => {
    setAsking(false);
    const field = returnTo.current; returnTo.current = null;
    if (!field) return;
    const back = () => { if (field.isConnected && (document.activeElement === document.body || !document.activeElement)) field.focus(); };
    requestAnimationFrame(() => field.isConnected && field.focus());
    window.setTimeout(back, 300); // after the question's exit motion, should its own focus return land on the page
  };
  // The question is a dialog nested in the form's own surface: when it closes, the form is the active dialog again (in the
  // accessibility tree and taking input), which a sibling dialog does not give back.
  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) { if (dirty) ask(); else close(); } }}>
      <DialogSurface>
        <TimeEntryDialog {...props} onClose={close} onDirtyChange={setDirty} />
        <ConfirmDialog open={asking} title={t('time.discardTitle')} confirm={t('time.discard')} cancel={t('time.keepEditing')}
          onConfirm={close} onCancel={keepEditing}>{t('time.discardBody')}</ConfirmDialog>
      </DialogSurface>
    </Dialog>
  );
}

/** Registers or edits manual CRM hours; task context never determines the hours author. */
export function TimeEntryDialog(props: TimeEntryDialogProps) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.timeOwn) && !user.permissions.includes(Permissions.timeManage)) return null;
  if (props.taskContext && (!user.permissions.includes(Permissions.activitiesRead) || !user.permissions.includes(Permissions.serviceRead))) return null;
  const scope = JSON.stringify([user.id, [...user.permissions].sort(), props.entry?.id, props.entry?.etag, props.defaultDate, props.taskContext]);
  return <TimeEntryForm key={scope} {...props} scope={scope} />;
}

function TimeEntryForm({ entry, defaultDate, taskContext, onClose, onDirtyChange, scope }: TimeEntryDialogProps & { scope: string }) {
  const styles = useDialogStyles();
  const local = useStyles();
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
  const workTypeInput = useRef<HTMLInputElement>(null);
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [onsite, setOnsite] = useState(entry?.onsite ?? false);
  const [afterHours, setAfterHours] = useState(entry?.afterHours ?? false);
  const [description, setDescription] = useState(entry?.description ?? '');
  const [ticket, setTicket] = useState(taskContext ? String(taskContext.ticket.externalId) : entry?.externalTicketId ? String(entry.externalTicketId) : '');
  const [ticketId, setTicketId] = useState(taskContext?.ticket.id ?? entry?.ticketId ?? null);
  const [sourceActivityId, setSourceActivityId] = useState(taskContext?.activityId ?? entry?.sourceActivityId ?? null);
  const [ticketTitle, setTicketTitle] = useState(taskContext?.ticket.title ?? entry?.ticketTitle ?? null);
  const [projectId, setProjectId] = useState(entry?.projectId ?? '');
  // M39.3: a new entry on an Atera ticket can also be recorded there; once it is saved, the dialog goes on into that confirmation.
  const [recordInAtera, setRecordInAtera] = useState(false);
  const [recording, setRecording] = useState<{ entryId: string; ticket: number } | null>(null);
  // The form as first shown, to know whether the person has typed anything since.
  const draft = JSON.stringify([organization?.id ?? null, workDate, hours, workType, billable, onsite, afterHours, description, ticket, projectId]);
  const [opened] = useState(draft);
  // A saved entry has nothing left to lose: the Atera step that follows never asks before closing.
  const dirty = draft !== opened && recording === null;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Only the customer's own open projects can take hours; the list is empty until a customer is picked.
  const { workTypes, projects: projectOptions } = useTimeFormOptions(scope, organization?.id);
  const projects = projectOptions.isSuccess && !projectOptions.isFetching ? projectOptions.data : [];

  const [errors, setErrors] = useState<Record<string, string>>({});
  const parsedHours = parseHours(hours);
  const hoursValue = parsedHours === null || Number.isNaN(parsedHours) ? parsedHours : roundHours(parsedHours);
  const ticketValue = ticket.trim() === '' ? null : Number(ticket.trim());
  // Each field says what is wrong with it once the person has left it, instead of only disabling Register (WCAG 3.3.1).
  const [left, setLeft] = useState<Record<'hours' | 'ticket' | 'description', boolean>>({ hours: false, ticket: false, description: false });
  const leave = (field: keyof typeof left) => () => setLeft((current) => (current[field] ? current : { ...current, [field]: true }));
  const hoursProblem = hoursValue === null ? 'time.hoursRequired' : Number.isNaN(hoursValue) ? 'time.hoursInvalid'
    : hoursValue <= 0 ? 'time.hoursPositive' : hoursValue > 24 ? 'time.hoursMax' : null;
  const ticketProblem = ticketValue !== null && (!Number.isSafeInteger(ticketValue) || ticketValue <= 0) ? 'time.ticketInvalid' : null;
  // Offered only for a new entry with a ticket number, and only while Atera takes recorded hours (its switches and the person's access).
  const canRecord = useActionAvailable('atera', 'time.record', !entry && ticketValue !== null && ticketProblem === null);
  const recordHint = useId('record-hint');
  const descriptionProblem = taskContext && !description.trim() ? 'time.descriptionRequired' : null;
  const invalid = !organization || hoursProblem !== null || ticketProblem !== null || descriptionProblem !== null;

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
      const created = entry ? null : await api.post<{ id: string }>('/api/v1/time/entries', request);
      if (entry) await api.put(`/api/v1/time/entries/${entry.id}`, request, entry.etag);
      if (!alive.current) return;
      void client.invalidateQueries({ queryKey: timeKeys.all });
      notify(entry ? t('time.saved') : t('time.registered'));
      if (created?.data?.id && canRecord && recordInAtera && ticketValue !== null) {
        setRecording({ entryId: created.data.id, ticket: ticketValue });
        return;
      }
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

  if (recording) {
    return <ActionConfirmation
      request={{ system: 'atera', kind: 'time.record', targetType: 'time-entry', targetId: recording.entryId, parameters: {} }}
      title={t('time.recordTitle', { number: `#${recording.ticket}` })} confirm={t('time.recordConfirm')}
      details={<Text block>{t('time.recordSaved')}</Text>} dismiss={t('time.recordSkip')} onClose={onClose} />;
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{entry ? t('time.editEntry') : t('time.newEntry')}</DialogTitle>
        <DialogContent>
          {taskContext && <Text block className={local.hint}>{t('taskTicket.timeHint')}</Text>}
          {failure && (!(failure instanceof ApiError && failure.status === 400) || Object.keys(errors).length === 0) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(failure, t)}</MessageBarBody>
            </MessageBar>
          )}
          <fieldset disabled={pending} className={mergeClasses(styles.grid, local.form)} style={{ border: 0, margin: 0, padding: 0 }}>
            <Field label={t('time.fields.organization')} required className={styles.wide} validationMessage={errors.organizationId}>
              {taskContext ? <Input value={taskContext.organization.name} readOnly /> : <TimeOrganizationPicker value={organization} onChange={changeOrganization} scope={scope} disabled={pending} />}
            </Field>
            <Field label={t('time.fields.workDate')} required validationMessage={errors.workDate}>
              <Input type="date" value={workDate} onChange={(_, d) => setWorkDate(d.value)} />
            </Field>
            <div className={local.hoursCell}>
              <Field label={t('time.fields.hours')} required validationMessage={errors.hours ?? (left.hours && hoursProblem ? t(hoursProblem) : undefined)}
                // Minutes and clock times are saved as hours: the field says how many, before anything is saved.
                hint={hoursProblem === null && typedAsMinutes(hours) ? t('time.hoursEcho', { hours: formatNumber(hoursValue) }) : undefined}>
                <Input ref={hoursInput} inputMode="decimal" value={hours} onChange={(_, d) => setHours(d.value)} onBlur={leave('hours')}
                  contentAfter={t('contracts.hoursShort')} />
              </Field>
              <div role="group" aria-label={t('time.commonDurations')} className={local.durations}>
                {commonDurations.map((value) => {
                  const label = value < 1 ? t('time.minutes', { count: value * 60 }) : `${formatNumber(value)} ${t('contracts.hoursShort')}`;
                  return <ToggleButton key={value} size="small" shape="circular" checked={hoursValue === value}
                    onClick={() => setHours(formatNumber(value))}>{label}</ToggleButton>;
                })}
              </div>
            </div>
            <Field label={t('time.fields.workType')}>
              <Combobox
                ref={workTypeInput}
                freeform
                input={{ className: local.comboInput }}
                value={workType}
                selectedOptions={workType ? [workType] : []}
                onInput={(event) => setWorkType((event.target as HTMLInputElement).value)}
                onOptionSelect={(_, d) => setWorkType(d.optionValue ?? '')}
                // Typed text leaves Fluent's matching option as the active descendant after the list closes, naming an option that
                // is gone (axe aria-valid-attr-value): a closed list names none.
                onOpenChange={(_, d) => { if (!d.open) queueMicrotask(() => workTypeInput.current?.removeAttribute('aria-activedescendant')); }}
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
            <Field label={t('time.fields.ticket')} className={styles.wide} hint={t(ticketId && !taskContext ? 'taskTicket.savedEntryHint' : 'time.ticketHint')}
              validationMessage={errors.externalTicketId ?? (left.ticket && ticketProblem ? t(ticketProblem) : undefined)}>
              <Input inputMode="numeric" value={taskContext ? `#${ticket} · ${taskContext.ticket.title}` : ticket} readOnly={Boolean(taskContext)} onBlur={leave('ticket')}
                onChange={(_, d) => { clearTicketContext(); setTicket(d.value); }} />
              {ticketId && !taskContext && <Button size="small" className={local.manual} onClick={clearTicketContext}>{t('taskTicket.useManual')}</Button>}
            </Field>
            {canRecord && <div className={local.record}>
              <Checkbox checked={recordInAtera} onChange={(_, d) => setRecordInAtera(Boolean(d.checked))} label={t('time.recordInAtera')}
                aria-describedby={recordHint} />
              <Text id={recordHint} className={local.recordHint}>{t('time.recordInAteraHint')}</Text>
            </div>}
            <div className={local.flags}>
              <Switch label={t('time.fields.billable')} checked={billable} onChange={(_, d) => setBillable(d.checked)} />
              <Switch label={t('time.fields.onsite')} checked={onsite} onChange={(_, d) => setOnsite(d.checked)} />
              <Switch label={t('time.fields.afterHours')} checked={afterHours} onChange={(_, d) => setAfterHours(d.checked)} />
            </div>
            <Field label={t('time.fields.description')} required={Boolean(taskContext)} className={styles.wide}
              validationMessage={errors.description ?? (left.description && descriptionProblem ? t(descriptionProblem) : undefined)}>
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} onBlur={leave('description')} resize="vertical" />
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
