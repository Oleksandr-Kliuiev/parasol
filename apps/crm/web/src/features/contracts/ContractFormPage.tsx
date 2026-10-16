import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../api/client';
import type { Organization, UserRef } from '../../api/types';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { ConflictBar } from '../../shared/forms/ConflictBar';
import { UnsavedChangesDialog } from '../../shared/forms/UnsavedChangesDialog';
import { useConflictFlow } from '../../shared/forms/useConflictFlow';
import { useUnsavedChanges } from '../../shared/forms/useUnsavedChanges';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, todayIso } from '../../shared/utils/format';
import { useCategories } from '../catalog/api';
import { useContract, useSaveContract, useSlaPolicies } from './api';
import { OrganizationPicker } from './OrganizationPicker';
import { contractTypes, invoiceFrequencies, invoiceTimings, type Contract, type ContractType, type InvoiceFrequency, type InvoiceTiming, type Ref } from './types';

const useStyles = makeStyles({
  sections: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '960px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  messages: { marginBottom: tokens.spacingVerticalL },
});

export function ContractFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [params] = useSearchParams();
  const existing = useContract(id);
  // "Keep my changes" after a conflict: the draft laid over the latest version, applied once the form is rebuilt from it.
  const [carried, setCarried] = useState<ContractDraft | null>(null);
  const organizationId = params.get('organizationId');
  const preset = useQuery({
    queryKey: ['organizations', 'detail', organizationId ?? ''],
    enabled: !id && Boolean(organizationId),
    queryFn: async ({ signal }) => api.get<Organization>(`/api/v1/customers/organizations/${organizationId}`, signal),
  });

  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  if ((id && !existing.data) || (organizationId && !id && preset.isPending)) return <Spinner label={t('common.loading')} />;
  const organization = preset.data ? { id: preset.data.data.id, name: preset.data.data.name } : null;
  return (
    <ContractForm
      key={existing.data?.etag ?? 'new'}
      id={id}
      initial={existing.data?.data}
      presetOrganization={organization}
      presetOwner={preset.data?.data.accountManager ?? null}
      etag={existing.data?.etag ?? null}
      carried={carried}
      onReload={() => {
        setCarried(null);
        void existing.refetch();
      }}
      onKeepMine={(draft) => {
        setCarried(draft);
        void existing.refetch();
      }}
    />
  );
}

interface ContractFormProps {
  id?: string;
  initial?: Contract;
  presetOrganization: Ref | null;
  presetOwner: UserRef | null;
  etag: string | null;
  carried: ContractDraft | null;
  onReload: () => void;
  onKeepMine: (draft: ContractDraft) => void;
}

function draftOf(initial: Contract | undefined, presetOrganization: Ref | null, presetOwner: UserRef | null) {
  return {
    organization: initial?.organization ?? presetOrganization,
    owner: initial?.owner ? { id: initial.owner.id, displayName: initial.owner.name } : presetOwner,
    values: {
      title: initial?.title ?? '',
      type: (initial?.type ?? 'Msp') as ContractType,
      startDate: initial?.startDate ?? todayIso(),
      endDate: initial?.endDate ?? '',
      autoRenew: initial?.autoRenew ?? true,
      renewalTermMonths: String(initial?.renewalTermMonths ?? 12),
      noticePeriodDays: String(initial?.noticePeriodDays ?? 90),
      slaPolicyId: initial?.slaPolicy?.id ?? '',
      invoiceFrequency: (initial?.invoiceFrequency ?? 'Monthly') as InvoiceFrequency,
      invoiceTiming: (initial?.invoiceTiming ?? 'InAdvance') as InvoiceTiming,
      priceCategory: initial?.priceCategory ?? '',
      indexation: initial?.indexation ?? false,
      nextIndexationDate: initial?.nextIndexationDate ?? '',
      customerReference: initial?.customerReference ?? '',
      notes: initial?.notes ?? '',
    },
  };
}

type ContractDraft = ReturnType<typeof draftOf>;

function ContractForm({ id, initial, presetOrganization, presetOwner, etag, carried, onReload, onKeepMine }: ContractFormProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const save = useSaveContract(id);
  const sla = useSlaPolicies();
  const categories = useCategories();
  const base = useMemo(() => draftOf(initial, presetOrganization, presetOwner), [initial, presetOrganization, presetOwner]);
  const start = carried ?? base;
  const [organization, setOrganization] = useState<Ref | null>(start.organization);
  const [owner, setOwner] = useState<UserRef | null>(start.owner);
  const [values, setValues] = useState(start.values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));
  const draft: ContractDraft = { organization, owner, values };
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const { blocker, markSaved } = useUnsavedChanges(dirty);
  const conflictError = save.error instanceof ApiError && save.error.status === 412 ? save.error : null;
  const conflictFlow = useConflictFlow<ContractDraft>({
    conflict: conflictError,
    base,
    getMine: () => draft,
    readLatest: async () => draftOf((await api.get<Contract>(`/api/v1/contracts/${id}`)).data, presetOrganization, presetOwner),
    labelOf: (path) => {
      const field = path.split('.').find((part) => part !== 'values') ?? path;
      return t(`contracts.fields.${field === 'slaPolicyId' ? 'sla' : field}`);
    },
  });
  const running = initial ? initial.status !== 'Draft' : false;
  const underNotice = initial?.status === 'NoticeGiven';

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!organization) next.organizationId = t('errors.validation');
    if (!values.title.trim()) next.title = t('errors.validation');
    if (values.endDate && values.endDate < values.startDate) next.endDate = t('contracts.form.endBeforeStart');
    if (values.autoRenew && !values.endDate) next.endDate = t('contracts.form.autoRenewNeedsEnd');
    const renewal = Number(values.renewalTermMonths);
    const notice = Number(values.noticePeriodDays);
    if (!Number.isInteger(renewal) || renewal < 0 || renewal > 60 || (values.autoRenew && renewal === 0)) next.renewalTermMonths = t('errors.validation');
    if (!Number.isInteger(notice) || notice < 0 || notice > 730) next.noticePeriodDays = t('errors.validation');
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      const response = await save.mutateAsync({
        etag,
        request: {
          organizationId: organization!.id,
          title: values.title.trim(),
          type: values.type,
          startDate: values.startDate,
          endDate: values.endDate || null,
          autoRenew: values.autoRenew,
          renewalTermMonths: renewal,
          noticePeriodDays: notice,
          slaPolicyId: values.slaPolicyId || null,
          invoiceFrequency: values.invoiceFrequency,
          invoiceTiming: values.invoiceTiming,
          priceCategory: values.priceCategory || null,
          indexation: values.indexation,
          nextIndexationDate: values.indexation ? values.nextIndexationDate || null : null,
          customerReference: blankToNull(values.customerReference),
          ownerId: owner?.id ?? null,
          notes: blankToNull(values.notes),
        },
      });
      notify(id ? t('contracts.form.saved') : t('contracts.form.created', { number: response.data.number }));
      markSaved();
      navigate(`/contracts/${response.data.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  const choice = <K extends 'type' | 'invoiceFrequency' | 'invoiceTiming'>(key: K, options: readonly string[], prefix: string) => (
    <Field label={t(`contracts.fields.${key}`)} required>
      <Dropdown value={t(`${prefix}.${values[key]}`)} selectedOptions={[values[key]]} onOptionSelect={(_, d) => set(key, d.optionValue as (typeof values)[K])}>
        {options.map((o) => (
          <Option key={o} value={o}>
            {t(`${prefix}.${o}`)}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );

  const error = (key: string) => ({ validationState: errors[key] ? ('error' as const) : ('none' as const), validationMessage: errors[key] });
  const conflict = save.error instanceof ApiError && save.error.status === 412;
  const otherError = save.error && !(save.error instanceof ApiError && [400, 412].includes(save.error.status));
  const cancelTo = id ? `/contracts/${id}` : presetOrganization ? `/organizations/${presetOrganization.id}?tab=contracts` : '/contracts';
  const defaultCategory = categories.data?.find((c) => c.isDefault);

  return (
    <>
      <UnsavedChangesDialog blocker={blocker} />
      <PageHeader title={id ? t('contracts.form.editTitle', { number: initial?.number }) : t('contracts.new')} back={{ to: cancelTo, label: t('common.back') }} />
      <div className={styles.messages} aria-live="polite">
        {conflict && (
          <ConflictBar
            details={conflictFlow.details}
            onUseLatest={() => {
              save.reset();
              onReload();
            }}
            onKeepMine={() => {
              const rebased = conflictFlow.keepMine();
              if (!rebased) return;
              save.reset();
              onKeepMine(rebased);
            }}
          />
        )}
        {otherError && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </div>
      <form className={styles.sections} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Panel title={t('contracts.sections.contract')}>
          <div className={styles.grid}>
            <Field label={t('contracts.fields.organization')} required className={styles.wide} hint={running ? t('contracts.form.organizationLocked') : undefined} {...error('organizationId')}>
              <OrganizationPicker value={organization} onChange={setOrganization} disabled={running} />
            </Field>
            <Field label={t('contracts.fields.title')} required className={styles.wide} {...error('title')}>
              <Input value={values.title} onChange={(_, d) => set('title', d.value)} />
            </Field>
            {choice('type', contractTypes, 'contracts.types')}
            <Field label={t('contracts.fields.owner')}>
              <UserPicker value={owner} onChange={setOwner} />
            </Field>
            <Field label={t('contracts.fields.customerReference')}>
              <Input value={values.customerReference} onChange={(_, d) => set('customerReference', d.value)} />
            </Field>
          </div>
        </Panel>

        <Panel title={t('contracts.sections.term')}>
          <div className={styles.grid}>
            <Field label={t('contracts.fields.startDate')} required {...error('startDate')}>
              <Input type="date" value={values.startDate} onChange={(_, d) => set('startDate', d.value)} />
            </Field>
            <Field label={t('contracts.fields.endDate')} hint={underNotice ? t('contracts.form.endLockedByNotice') : t('contracts.form.endDateHint')} {...error('endDate')}>
              <Input type="date" value={values.endDate} disabled={underNotice} onChange={(_, d) => set('endDate', d.value)} />
            </Field>
            <Field label={t('contracts.fields.noticePeriodDays')} {...error('noticePeriodDays')}>
              <Input type="number" min={0} value={values.noticePeriodDays} onChange={(_, d) => set('noticePeriodDays', d.value)} contentAfter={t('contracts.days')} />
            </Field>
            <Switch className={styles.wide} label={t('contracts.fields.autoRenew')} checked={values.autoRenew} onChange={(_, d) => set('autoRenew', d.checked)} />
            {values.autoRenew && (
              <Field label={t('contracts.fields.renewalTermMonths')} {...error('renewalTermMonths')}>
                <Input type="number" min={1} value={values.renewalTermMonths} onChange={(_, d) => set('renewalTermMonths', d.value)} contentAfter={t('contracts.months')} />
              </Field>
            )}
          </div>
        </Panel>

        <Panel title={t('contracts.sections.serviceAndBilling')}>
          <div className={styles.grid}>
            <Field label={t('contracts.fields.sla')}>
              <Dropdown
                value={sla.data?.find((p) => p.id === values.slaPolicyId)?.name ?? (values.slaPolicyId ? (initial?.slaPolicy?.name ?? '') : t('contracts.form.noSla'))}
                selectedOptions={[values.slaPolicyId]}
                onOptionSelect={(_, d) => set('slaPolicyId', d.optionValue ?? '')}
              >
                <Option value="">{t('contracts.form.noSla')}</Option>
                {(sla.data ?? []).map((p) => (
                  <Option key={p.id} value={p.id}>
                    {p.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('contracts.fields.priceCategory')} hint={t('contracts.form.priceCategoryHint')}>
              <Dropdown
                value={values.priceCategory ? (categories.data?.find((c) => c.code === values.priceCategory)?.name ?? values.priceCategory) : t('contracts.form.defaultCategory', { name: defaultCategory?.name ?? '' })}
                selectedOptions={[values.priceCategory]}
                onOptionSelect={(_, d) => set('priceCategory', d.optionValue ?? '')}
              >
                <Option value="" text={t('contracts.form.defaultCategory', { name: defaultCategory?.name ?? '' })}>
                  {t('contracts.form.defaultCategory', { name: defaultCategory?.name ?? '' })}
                </Option>
                {(categories.data ?? []).map((c) => (
                  <Option key={c.code} value={c.code}>
                    {c.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {choice('invoiceFrequency', invoiceFrequencies, 'contracts.frequencies')}
            {choice('invoiceTiming', invoiceTimings, 'contracts.timings')}
            <Switch label={t('contracts.fields.indexation')} checked={values.indexation} onChange={(_, d) => set('indexation', d.checked)} />
            {values.indexation && (
              <Field label={t('contracts.fields.nextIndexationDate')}>
                <Input type="date" value={values.nextIndexationDate} onChange={(_, d) => set('nextIndexationDate', d.value)} />
              </Field>
            )}
            <Field label={t('contracts.fields.notes')} className={styles.wide}>
              <Textarea value={values.notes} onChange={(_, d) => set('notes', d.value)} resize="vertical" />
            </Field>
          </div>
        </Panel>

        <div className={styles.actions}>
          <Button onClick={() => navigate(cancelTo)}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : id ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </>
  );
}
