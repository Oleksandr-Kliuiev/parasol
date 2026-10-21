import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Controller, useForm, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Building16Regular, ContactCard16Regular, Location16Regular, Person16Regular, Receipt16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { api, ApiError } from '../../api/client';
import { organizationStatuses, type Address, type Organization, type OrganizationRequest, type RegistryOrganization, type RegistryStatus } from '../../api/types';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { ConflictBar } from '../../shared/forms/ConflictBar';
import { useConflictFlow } from '../../shared/forms/useConflictFlow';
import { UnsavedChangesDialog } from '../../shared/forms/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../shared/forms/useUnsavedChanges';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { blankToNull } from '../../shared/utils/format';
import { formatOrgNumber, isValidOrgNumber, normalizeOrgNumber } from '../../shared/utils/orgNumber';
import { useOrganization, useSaveOrganization } from './api';
import { RegistryLookup } from './RegistryLookup';
import { useCustomerSettings } from '../integrations/api';

const useStyles = makeStyles({
  // The fields stay a readable width (about 760 px); the register lookup sits beside them on a wide screen.
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 760px) minmax(280px, 360px)',
    gap: '24px',
    alignItems: 'start',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 760px)' },
  },
  // The register lookup is the first step of a new customer, so it comes first in the page's order (and the Tab order):
  // above the fields on a narrow screen, beside them on a wide one (WCAG 1.3.2, 2.4.3).
  aside: { position: 'sticky', top: '88px', gridColumn: 2, gridRow: 1, '@media (max-width: 1100px)': { position: 'static', gridColumn: 1, gridRow: 'auto' } },
  sections: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0, gridColumn: 1, gridRow: 1, '@media (max-width: 1100px)': { gridRow: 'auto' } },
  // Fields start at the top of their row (a hint under one field must not stretch its neighbours) and a dropdown
  // gives up Fluent's 250 px minimum to fit its column.
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    gap: '14px 16px',
    alignItems: 'start',
    '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 },
  },
  wide: { gridColumn: '1 / -1' },
  // One address: street across, postal code, city and country under it; a hairline between the three addresses.
  address: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)',
    gap: '14px 16px',
    alignItems: 'start',
    ':not(:first-child)': { borderTop: `1px solid ${h.line}`, paddingTop: '16px', marginTop: '4px' },
    // Inputs shrink with their column instead of keeping the browser's 20-character width.
    '& > *, & .fui-Input': { minWidth: 0 },
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  addresses: { display: 'grid', gap: '16px' },
  addressTitle: { gridColumn: '1 / -1', margin: 0, fontSize: '13px', lineHeight: '18px', fontWeight: tokens.fontWeightSemibold, color: h.muted },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' },
  messages: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', ':empty': { marginBottom: 0 } },
});

const emptyAddress = { street: '', postalCode: '', city: '', countryCode: 'NO' };
type AddressValues = typeof emptyAddress;
const addressKeys = ['visitAddress', 'postalAddress', 'billingAddress'] as const;

function toAddressValues(address: Address | null | undefined): AddressValues {
  return {
    street: address?.street ?? '',
    postalCode: address?.postalCode ?? '',
    city: address?.city ?? '',
    countryCode: address?.countryCode ?? 'NO',
  };
}

function toAddress(values: AddressValues): Address {
  return {
    street: blankToNull(values.street),
    postalCode: blankToNull(values.postalCode),
    city: blankToNull(values.city),
    countryCode: blankToNull(values.countryCode)?.toUpperCase() ?? null,
  };
}

function useSchema() {
  const { t } = useTranslation();
  return useMemo(() => {
    // Each field says what it wants (WCAG 3.3.3), not only that something is wrong.
    const optionalEmail = z.string().trim().refine((v) => v === '' || z.email().safeParse(v).success, t('organizations.form.invalidEmail'));
    const address = z.object({
      street: z.string().max(256),
      postalCode: z.string().max(16),
      city: z.string().max(128),
      countryCode: z.string().trim().refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), t('organizations.form.invalidCountry')),
    });
    return z.object({
      name: z.string().trim().min(1, t('organizations.form.nameRequired')).max(256),
      orgNumber: z.string().refine((v) => v.trim() === '' || isValidOrgNumber(v), t('organizations.form.invalidOrgNumber')),
      legalForm: z.string().max(16),
      status: z.enum(organizationStatuses),
      naceCode: z.string().max(16),
      website: z.string().max(256),
      phone: z.string().max(32),
      email: optionalEmail,
      invoiceEmail: optionalEmail,
      ehfEnabled: z.boolean(),
      accountManager: z.object({ id: z.string(), displayName: z.string() }).nullable(),
      primaryTechnician: z.object({ id: z.string(), displayName: z.string() }).nullable(),
      visitAddress: address,
      postalAddress: address,
      billingAddress: address,
      domains: z.string().refine(
        (v) => v.split(',').map((d) => d.trim()).filter(Boolean).every((d) => /^@?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(d)),
        t('organizations.form.invalidDomains'),
      ),
    });
  }, [t]);
}

type FormValues = z.infer<ReturnType<typeof useSchema>>;

const defaults: FormValues = {
  name: '',
  orgNumber: '',
  legalForm: '',
  status: 'Prospect',
  naceCode: '',
  website: '',
  phone: '',
  email: '',
  invoiceEmail: '',
  ehfEnabled: false,
  accountManager: null,
  primaryTechnician: null,
  visitAddress: emptyAddress,
  postalAddress: emptyAddress,
  billingAddress: emptyAddress,
  domains: '',
};

function toFormValues(o: Organization): FormValues {
  return {
    name: o.name,
    orgNumber: formatOrgNumber(o.orgNumber),
    legalForm: o.legalForm ?? '',
    status: o.status,
    naceCode: o.naceCode ?? '',
    website: o.website ?? '',
    phone: o.phone ?? '',
    email: o.email ?? '',
    invoiceEmail: o.invoiceEmail ?? '',
    ehfEnabled: o.ehfEnabled,
    accountManager: o.accountManager,
    primaryTechnician: o.primaryTechnician,
    visitAddress: toAddressValues(o.visitAddress),
    postalAddress: toAddressValues(o.postalAddress),
    billingAddress: toAddressValues(o.billingAddress),
    domains: o.domains.join(', '),
  };
}

function toRequest(v: FormValues): OrganizationRequest {
  return {
    name: v.name.trim(),
    orgNumber: blankToNull(v.orgNumber) ? normalizeOrgNumber(v.orgNumber) : null,
    legalForm: blankToNull(v.legalForm),
    status: v.status,
    naceCode: blankToNull(v.naceCode),
    website: blankToNull(v.website),
    phone: blankToNull(v.phone),
    email: blankToNull(v.email),
    invoiceEmail: blankToNull(v.invoiceEmail),
    ehfEnabled: v.ehfEnabled,
    accountManagerId: v.accountManager?.id ?? null,
    primaryTechnicianId: v.primaryTechnician?.id ?? null,
    visitAddress: toAddress(v.visitAddress),
    postalAddress: toAddress(v.postalAddress),
    billingAddress: toAddress(v.billingAddress),
    domains: v.domains.split(',').map((d) => d.trim()).filter(Boolean),
  };
}

export function OrganizationFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const existing = useOrganization(id);
  // "Keep my changes" after a conflict: the draft laid over the latest version, applied once the form is rebuilt from it.
  const [carried, setCarried] = useState<FormValues | null>(null);

  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  if (id && !existing.data) return <Spinner label={t('common.loading')} />;

  // Keyed by version: reloading after a concurrency conflict remounts the form with the latest values.
  return (
    <OrganizationForm
      key={existing.data?.etag ?? 'new'}
      id={id}
      initial={existing.data?.data}
      etag={existing.data?.etag ?? null}
      carried={carried}
      onReload={() => {
        setCarried(null);
        void existing.refetch();
      }}
      onKeepMine={(values) => {
        setCarried(values);
        void existing.refetch();
      }}
    />
  );
}

interface OrganizationFormProps {
  id: string | undefined;
  initial: Organization | undefined;
  etag: string | null;
  carried: FormValues | null;
  onReload: () => void;
  onKeepMine: (values: FormValues) => void;
}

function OrganizationForm({ id, initial, etag, carried, onReload, onKeepMine }: OrganizationFormProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const isEdit = Boolean(id);
  const schema = useSchema();
  const save = useSaveOrganization(id);
  const settings = useCustomerSettings();
  const billingManaged = settings.data?.billingDetailsMaster === 'PowerOffice';
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [registryWarning, setRegistryWarning] = useState<RegistryStatus | null>(null);

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: initial ? toFormValues(initial) : defaults, mode: 'onBlur' });

  const base = useMemo(() => (initial ? toFormValues(initial) : defaults), [initial]);
  const { blocker, markSaved } = useUnsavedChanges(isDirty);
  useEffect(() => {
    if (carried) reset(carried, { keepDefaultValues: true });
    // Only when the form is rebuilt from the latest version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const conflictState = save.error instanceof ApiError && save.error.status === 412;
  const conflictFlow = useConflictFlow<FormValues>({
    conflict: conflictState ? save.error : null,
    base,
    getMine: () => getValues(),
    readLatest: async () => toFormValues((await api.get<Organization>(`/api/v1/customers/organizations/${id}`)).data),
    labelOf: (path) => t(`organizations.fields.${path.split('.')[0]}`),
  });

  const applyRegistry = (r: RegistryOrganization) => {
    const opts = { shouldDirty: true, shouldValidate: true } as const;
    setValue('name', r.name, opts);
    setValue('orgNumber', formatOrgNumber(r.orgNumber), opts);
    setValue('legalForm', r.legalForm ?? '', opts);
    setValue('naceCode', r.naceCode ?? '', opts);
    if (r.website) setValue('website', r.website, opts);
    if (r.email) setValue('email', r.email.toLowerCase(), opts);
    if (r.phone) setValue('phone', r.phone, opts);
    if (r.businessAddress) setValue('visitAddress', toAddressValues(r.businessAddress), opts);
    setValue('postalAddress', toAddressValues(r.postalAddress ?? r.businessAddress), opts);
    setRegistryWarning(r.status !== 'Active' ? r.status : null);
    setDuplicateId(null);
    notify(t('organizations.form.registryApplied', { name: r.name }), 'info');
  };

  const onSubmit = handleSubmit(async (values) => {
    setDuplicateId(null);
    try {
      const response = await save.mutateAsync({ request: toRequest(values), etag });
      notify(isEdit ? t('organizations.form.saved') : t('organizations.form.created'));
      markSaved();
      navigate(`/organizations/${response.data.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CUS_DUPLICATE_ORGNR') {
        setDuplicateId(String(error.problem.existingId));
        setError('orgNumber', { message: t('organizations.form.duplicate') });
        return;
      }
      if (error instanceof ApiError && error.status === 400) {
        for (const [path, message] of Object.entries(error.fieldErrors)) {
          const field = path.replace(/\[\d+\]$/, '') as FieldPath<FormValues>;
          setError(field, { message });
        }
        return;
      }
      // Concurrency and other errors are shown by the mutation error message bar.
    }
  });

  const text = (name: FieldPath<FormValues>, label: string, props: { type?: 'email' | 'url' | 'tel'; hint?: string; required?: boolean; className?: string; inputMode?: 'numeric'; disabled?: boolean } = {}) => (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          required={props.required}
          hint={props.hint}
          className={props.className}
          validationState={fieldState.error ? 'error' : 'none'}
          validationMessage={fieldState.error?.message}
        >
          <Input
            type={props.type}
            inputMode={props.inputMode}
            value={String(field.value ?? '')}
            onChange={(_, d) => field.onChange(d.value)}
            onBlur={field.onBlur}
            name={field.name}
            ref={field.ref}
            disabled={props.disabled}
          />
        </Field>
      )}
    />
  );

  const concurrencyConflict = conflictState;
  const otherError = save.error && !(save.error instanceof ApiError && [400, 409, 412].includes(save.error.status));
  const title = isEdit ? t('organizations.form.editTitle', { name: initial?.name }) : t('organizations.form.createTitle');
  const cancelTo = isEdit ? `/organizations/${id}` : '/organizations';

  return (
    <>
      <UnsavedChangesDialog blocker={blocker} />
      <PageHeader title={title} back={{ to: cancelTo, label: t('common.back') }} />
      <div className={styles.messages} aria-live="polite">
        {duplicateId && (
          <MessageBar intent="warning">
            <MessageBarBody>{t('organizations.form.duplicate')}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={() => navigate(`/organizations/${duplicateId}`)}>
                {t('organizations.form.openExisting')}
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
        {registryWarning && (
          <MessageBar intent="warning">
            <MessageBarBody>{t('organizations.form.registryWarning', { status: t(`registry.${registryWarning}`) })}</MessageBarBody>
          </MessageBar>
        )}
        {concurrencyConflict && (
          <ConflictBar
            details={conflictFlow.details}
            onUseLatest={() => {
              save.reset();
              onReload();
            }}
            onKeepMine={() => {
              const values = conflictFlow.keepMine();
              if (!values) return;
              save.reset();
              onKeepMine(values);
            }}
          />
        )}
        {otherError && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
          </MessageBar>
        )}
        {Object.keys(errors).length > 0 && (
          <MessageBar intent="error">
            <MessageBarBody>{t('errors.validation')}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <form onSubmit={(e) => void onSubmit(e)} noValidate className={styles.layout}>
        {!isEdit && (
          <aside className={styles.aside}>
            <RegistryLookup onSelect={applyRegistry} />
          </aside>
        )}
        <div className={styles.sections}>
          <Panel title={t('organizations.sections.company')} icon={<Building16Regular />}>
            <div className={styles.grid}>
              {text('name', t('organizations.fields.name'), { required: true, className: styles.wide })}
              {text('orgNumber', t('organizations.fields.orgNumber'), { inputMode: 'numeric' })}
              {text('legalForm', t('organizations.fields.legalForm'))}
              <Controller
                name="status"
                control={control}
                render={({ field }) => (
                  <Field label={t('organizations.fields.status')} required>
                    <Dropdown
                      value={t(`status.${field.value}`)}
                      selectedOptions={[field.value]}
                      onOptionSelect={(_, d) => field.onChange(d.optionValue)}
                    >
                      {organizationStatuses.map((s) => (
                        <Option key={s} value={s}>
                          {t(`status.${s}`)}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}
              />
              {text('naceCode', t('organizations.fields.naceCode'))}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.contactInfo')} icon={<ContactCard16Regular />}>
            <div className={styles.grid}>
              {text('email', t('organizations.fields.email'), { type: 'email' })}
              {text('phone', t('organizations.fields.phone'), { type: 'tel' })}
              {text('website', t('organizations.fields.website'), { type: 'url' })}
              {text('domains', t('organizations.fields.domains'), { hint: t('organizations.fields.domainsHint'), className: styles.wide })}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.responsibility')} icon={<Person16Regular />}>
            <div className={styles.grid}>
              {(['accountManager', 'primaryTechnician'] as const).map((name) => (
                <Controller
                  key={name}
                  name={name}
                  control={control}
                  render={({ field }) => (
                    <Field label={t(`organizations.fields.${name}`)}>
                      <UserPicker value={field.value} onChange={field.onChange} />
                    </Field>
                  )}
                />
              ))}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.addresses')} icon={<Location16Regular />}>
            <div className={styles.addresses}>
              {addressKeys.map((key) => (
                <div key={key} className={styles.address}>
                  <h3 className={styles.addressTitle}>{t(`organizations.fields.${key}`)}</h3>
                  {text(`${key}.street`, t('organizations.fields.street'), { className: styles.wide, disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.postalCode`, t('organizations.fields.postalCode'), { inputMode: 'numeric', disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.city`, t('organizations.fields.city'), { disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.countryCode`, t('organizations.fields.countryCode'), { disabled: billingManaged && key === 'billingAddress' })}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.invoicing')} icon={<Receipt16Regular />}>
            <div className={styles.grid}>
              {text('invoiceEmail', t('organizations.fields.invoiceEmail'), {
                type: 'email',
                disabled: billingManaged,
                hint: billingManaged ? t('linkedSystems.billingManaged') : undefined,
              })}
              <Controller
                name="ehfEnabled"
                control={control}
                render={({ field }) => (
                  <Field label={t('organizations.fields.ehfEnabled')}>
                    <Switch checked={field.value} onChange={(_, d) => field.onChange(d.checked)} disabled={billingManaged} />
                  </Field>
                )}
              />
            </div>
          </Panel>

          <div className={styles.actions}>
            <Button onClick={() => navigate(cancelTo)}>{t('common.cancel')}</Button>
            <Button appearance="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : isEdit ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
