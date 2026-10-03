import { useMemo, useState } from 'react';
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
  MessageBarTitle,
  Option,
  Spinner,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { organizationStatuses, type Address, type Organization, type OrganizationRequest, type RegistryOrganization, type RegistryStatus } from '../../api/types';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { blankToNull } from '../../shared/utils/format';
import { formatOrgNumber, isValidOrgNumber, normalizeOrgNumber } from '../../shared/utils/orgNumber';
import { useOrganization, useSaveOrganization } from './api';
import { RegistryLookup } from './RegistryLookup';
import { useCustomerSettings } from '../integrations/api';

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 380px)',
    gap: tokens.spacingHorizontalXL,
    alignItems: 'start',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  aside: { position: 'sticky', top: '68px', '@media (max-width: 1100px)': { position: 'static', order: -1 } },
  sections: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
  },
  wide: { gridColumn: '1 / -1' },
  addressTitle: { gridColumn: '1 / -1', margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  messages: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalL },
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
    const optionalEmail = z.string().trim().refine((v) => v === '' || z.email().safeParse(v).success, t('errors.validation'));
    const address = z.object({
      street: z.string().max(256),
      postalCode: z.string().max(16),
      city: z.string().max(128),
      countryCode: z.string().trim().refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), t('errors.validation')),
    });
    return z.object({
      name: z.string().trim().min(1, t('errors.validation')).max(256),
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
        t('errors.validation'),
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

  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  if (id && !existing.data) return <Spinner label={t('common.loading')} />;

  // Keyed by version: reloading after a concurrency conflict remounts the form with the latest values.
  return (
    <OrganizationForm
      key={existing.data?.etag ?? 'new'}
      id={id}
      initial={existing.data?.data}
      etag={existing.data?.etag ?? null}
      onReload={() => void existing.refetch()}
    />
  );
}

interface OrganizationFormProps {
  id: string | undefined;
  initial: Organization | undefined;
  etag: string | null;
  onReload: () => void;
}

function OrganizationForm({ id, initial, etag, onReload }: OrganizationFormProps) {
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
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: initial ? toFormValues(initial) : defaults, mode: 'onBlur' });

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

  const concurrencyConflict = save.error instanceof ApiError && save.error.status === 412;
  const otherError = save.error && !(save.error instanceof ApiError && [400, 409, 412].includes(save.error.status));
  const title = isEdit ? t('organizations.form.editTitle', { name: initial?.name }) : t('organizations.form.createTitle');
  const cancelTo = isEdit ? `/organizations/${id}` : '/organizations';

  return (
    <>
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
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{t('errors.generic')}</MessageBarTitle>
              {t('errors.concurrency')}
            </MessageBarBody>
            <MessageBarActions>
              <Button
                size="small"
                onClick={() => {
                  save.reset();
                  onReload();
                }}
              >
                {t('common.reload')}
              </Button>
            </MessageBarActions>
          </MessageBar>
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
        <div className={styles.sections}>
          <Panel title={t('organizations.sections.company')}>
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

          <Panel title={t('organizations.sections.contactInfo')}>
            <div className={styles.grid}>
              {text('email', t('organizations.fields.email'), { type: 'email' })}
              {text('phone', t('organizations.fields.phone'), { type: 'tel' })}
              {text('website', t('organizations.fields.website'), { type: 'url' })}
              {text('domains', t('organizations.fields.domains'), { hint: t('organizations.fields.domainsHint'), className: styles.wide })}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.responsibility')}>
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

          <Panel title={t('organizations.sections.addresses')}>
            <div className={styles.grid}>
              {addressKeys.map((key) => (
                <div key={key} className={styles.wide} style={{ display: 'contents' }}>
                  <h3 className={styles.addressTitle}>{t(`organizations.fields.${key}`)}</h3>
                  {text(`${key}.street`, t('organizations.fields.street'), { className: styles.wide, disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.postalCode`, t('organizations.fields.postalCode'), { inputMode: 'numeric', disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.city`, t('organizations.fields.city'), { disabled: billingManaged && key === 'billingAddress' })}
                  {text(`${key}.countryCode`, t('organizations.fields.countryCode'), { disabled: billingManaged && key === 'billingAddress' })}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={t('organizations.sections.invoicing')}>
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

        {!isEdit && (
          <aside className={styles.aside}>
            <RegistryLookup onSelect={applyRegistry} />
          </aside>
        )}
      </form>
    </>
  );
}
