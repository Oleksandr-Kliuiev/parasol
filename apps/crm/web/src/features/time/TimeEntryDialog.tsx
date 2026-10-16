import { useState } from 'react';
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
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDialogStyles } from '../contracts/dialogStyles';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import type { Ref } from '../contracts/types';
import { useAllProjects } from '../projects/api';
import { useTimeActions, useWorkTypes } from './api';
import type { TimeEntry } from './types';

/** Registers or edits time entered in the CRM (FR-TIM-02). Entries from Atera are read-only here. */
export function TimeEntryDialog({ entry, defaultDate, onClose }: { entry?: TimeEntry; defaultDate?: string; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useTimeActions();
  const workTypes = useWorkTypes();
  const [organization, setOrganization] = useState<Ref | null>(
    entry ? { id: entry.organizationId, name: entry.organizationName ?? '' } : null,
  );
  const [workDate, setWorkDate] = useState(entry?.workDate ?? defaultDate ?? todayIso());
  const [hours, setHours] = useState(entry ? String(entry.hours) : '1');
  const [workType, setWorkType] = useState(entry?.workType ?? '');
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [onsite, setOnsite] = useState(entry?.onsite ?? false);
  const [afterHours, setAfterHours] = useState(entry?.afterHours ?? false);
  const [description, setDescription] = useState(entry?.description ?? '');
  const [ticket, setTicket] = useState(entry?.externalTicketId ? String(entry.externalTicketId) : '');
  const [projectId, setProjectId] = useState(entry?.projectId ?? '');
  // Only the customer's own open projects can take hours; the list is empty until a customer is picked.
  const projectOptions = useAllProjects({ organizationId: organization?.id, openOnly: true }, Boolean(organization));
  const projects = projectOptions.data ?? [];

  const [errors, setErrors] = useState<Record<string, string>>({});
  const hoursValue = parseDecimal(hours);
  const ticketValue = ticket.trim() === '' ? null : Number(ticket.trim());
  const invalid = !organization || hoursValue === null || Number.isNaN(hoursValue) || hoursValue <= 0 || hoursValue > 24 || (ticketValue !== null && !Number.isInteger(ticketValue));

  const submit = async () => {
    if (invalid) return;
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
      ticketTitle: entry?.ticketTitle ?? null,
      projectId: projectId === '' ? null : projectId,
    };
    try {
      if (entry) await actions.update.mutateAsync({ id: entry.id, request, etag: entry.etag });
      else await actions.create.mutateAsync(request);
      notify(entry ? t('time.saved') : t('time.registered'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  const mutation = entry ? actions.update : actions.create;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{entry ? t('time.editEntry') : t('time.newEntry')}</DialogTitle>
        <DialogContent>
          {mutation.error && !(mutation.error instanceof ApiError && mutation.error.status === 400) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('time.fields.organization')} required className={styles.wide} validationMessage={errors.organizationId}>
              <OrganizationPicker value={organization} onChange={setOrganization} />
            </Field>
            <Field label={t('time.fields.workDate')} required validationMessage={errors.workDate}>
              <Input type="date" value={workDate} onChange={(_, d) => setWorkDate(d.value)} />
            </Field>
            <Field label={t('time.fields.hours')} required validationMessage={errors.hours}>
              <Input inputMode="decimal" value={hours} onChange={(_, d) => setHours(d.value)} contentAfter={t('contracts.hoursShort')} />
            </Field>
            <Field label={t('time.fields.workType')}>
              <Combobox
                freeform
                value={workType}
                selectedOptions={workType ? [workType] : []}
                onInput={(event) => setWorkType((event.target as HTMLInputElement).value)}
                onOptionSelect={(_, d) => setWorkType(d.optionValue ?? '')}
              >
                {(workTypes.data ?? []).map((type) => (
                  <Option key={type} value={type}>
                    {type}
                  </Option>
                ))}
              </Combobox>
            </Field>
            {/* FR-PRJ-01: hours on an implementation project are booked to it, so plan against actual stays honest. */}
            <Field label={t('time.fields.project')} hint={projects.length === 0 ? t('time.noProjects') : undefined}>
              <Dropdown
                disabled={projects.length === 0}
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
            <Field label={t('time.fields.ticket')} hint={t('time.ticketHint')} validationMessage={errors.externalTicketId}>
              <Input inputMode="numeric" value={ticket} onChange={(_, d) => setTicket(d.value)} />
            </Field>
            <Switch label={t('time.fields.billable')} checked={billable} onChange={(_, d) => setBillable(d.checked)} />
            <Switch label={t('time.fields.onsite')} checked={onsite} onChange={(_, d) => setOnsite(d.checked)} />
            <Switch label={t('time.fields.afterHours')} checked={afterHours} onChange={(_, d) => setAfterHours(d.checked)} />
            <Field label={t('time.fields.description')} className={styles.wide} validationMessage={errors.description}>
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || mutation.isPending}>
            {entry ? t('common.save') : t('time.register')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
