import { useState } from 'react';
import {
  Button,
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
  Textarea,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal } from '../../shared/utils/format';
import type { UserRef } from '../../api/types';
import { useDialogStyles } from '../contracts/dialogStyles';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import type { Ref as OrganizationRef } from '../contracts/types';
import { useProjectActions } from './api';
import { projectBillingModels, projectTypes, type Project, type ProjectBillingModel, type ProjectType } from './types';

interface ProjectDialogProps {
  onClose: () => void;
  onCreated?: (id: string) => void;
  project?: Project;
  organization?: OrganizationRef;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Creates or edits an implementation project (FR-PRJ-01). */
export function ProjectDialog({ onClose, onCreated, project, organization }: ProjectDialogProps) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useProjectActions(project?.id);
  const canSeeMoney = useCan(Permissions.financeRead);
  const [customer, setCustomer] = useState<OrganizationRef | null>(
    project ? { id: project.organization.id, name: project.organization.name } : (organization ?? null),
  );
  const [name, setName] = useState(project?.name ?? '');
  const [type, setType] = useState<ProjectType>(project?.type ?? 'M365Migration');
  const [billingModel, setBillingModel] = useState<ProjectBillingModel>(project?.billingModel ?? 'PerPhase');
  const [manager, setManager] = useState<UserRef | null>(project?.manager ? { id: project.manager.id, displayName: project.manager.name } : null);
  const [startDate, setStartDate] = useState(project?.startDate ?? today());
  const [endDate, setEndDate] = useState(project?.endDate ?? '');
  const [budgetHours, setBudgetHours] = useState(String(project?.progress.budgetHours ?? 0));
  const [budgetAmount, setBudgetAmount] = useState(String(project?.progress.budgetAmount ?? 0));
  const [notes, setNotes] = useState(project?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalid = !customer || !name.trim() || !startDate;

  const submit = async () => {
    if (invalid) return;
    const request = {
      organizationId: customer.id,
      name: name.trim(),
      type,
      billingModel,
      managerId: manager?.id ?? null,
      startDate,
      endDate: blankToNull(endDate),
      budgetHours: parseDecimal(budgetHours) ?? 0,
      budgetAmount: canSeeMoney ? (parseDecimal(budgetAmount) ?? 0) : (project?.progress.budgetAmount ?? 0),
      contractId: project?.contractId ?? null,
      opportunityId: project?.opportunityId ?? null,
      notes: blankToNull(notes),
    };
    try {
      const saved = await actions.save.mutateAsync({ request, etag: project?.etag });
      notify(project ? t('projects.saved') : t('projects.created'));
      onCreated?.(saved.data.id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setErrors(e.fieldErrors);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{project ? t('projects.editTitle') : t('projects.newTitle')}</DialogTitle>
        <DialogContent>
          {actions.save.error && !(actions.save.error instanceof ApiError && actions.save.error.status === 400) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(actions.save.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('projects.fields.customer')} required className={styles.wide} validationMessage={errors.organizationId}>
              <OrganizationPicker value={customer} onChange={setCustomer} disabled={Boolean(project)} />
            </Field>
            <Field label={t('projects.fields.name')} required className={styles.wide} validationMessage={errors.name}>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('projects.fields.type')}>
              <Dropdown value={t(`projects.types.${type}`)} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue as ProjectType)}>
                {projectTypes.map((value) => (
                  <Option key={value} value={value}>
                    {t(`projects.types.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('projects.fields.billingModel')} hint={t(`projects.billingModelHints.${billingModel}`)}>
              <Dropdown
                value={t(`projects.billingModels.${billingModel}`)}
                selectedOptions={[billingModel]}
                onOptionSelect={(_, d) => setBillingModel(d.optionValue as ProjectBillingModel)}
              >
                {projectBillingModels.map((value) => (
                  <Option key={value} value={value}>
                    {t(`projects.billingModels.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('projects.fields.manager')}>
              <UserPicker value={manager} onChange={setManager} />
            </Field>
            <Field label={t('projects.fields.startDate')} required validationMessage={errors.startDate}>
              <Input type="date" value={startDate} onChange={(_, d) => setStartDate(d.value)} />
            </Field>
            <Field label={t('projects.fields.endDate')} validationMessage={errors.endDate}>
              <Input type="date" value={endDate} onChange={(_, d) => setEndDate(d.value)} />
            </Field>
            <Field label={t('projects.fields.budgetHours')} validationMessage={errors.budgetHours}>
              <Input inputMode="decimal" value={budgetHours} onChange={(_, d) => setBudgetHours(d.value)} />
            </Field>
            {canSeeMoney && (
              <Field label={t('projects.fields.budgetAmount')} validationMessage={errors.budgetAmount}>
                <Input inputMode="decimal" value={budgetAmount} onChange={(_, d) => setBudgetAmount(d.value)} contentAfter="NOK" />
              </Field>
            )}
            <Field label={t('projects.fields.notes')} className={styles.wide} validationMessage={errors.notes}>
              <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} resize="vertical" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.save.isPending}>
            {project ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
