import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, Box16Regular, BoxMultiple20Regular, Cloud16Regular, Delete20Regular, Money16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { ConflictBar } from '../../shared/forms/ConflictBar';
import { UnsavedChangesDialog } from '../../shared/forms/UnsavedChangesDialog';
import { useConflictFlow } from '../../shared/forms/useConflictFlow';
import { useUnsavedChanges } from '../../shared/forms/useUnsavedChanges';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal } from '../../shared/utils/format';
import { useProduct, useSaveProduct } from './api';
import { ProductPicker } from './ProductPicker';
import {
  billingPeriods,
  businessLines,
  commitmentTerms,
  productTypes,
  productUnits,
  vatRates,
  type BillingPeriod,
  type BusinessLine,
  type CommitmentTerm,
  type Product,
  type ProductListItem,
  type ProductType,
  type ProductUnit,
} from './types';

const useStyles = makeStyles({
  // Cards of a readable width, two columns where they fit; a field across both stays under 700 px.
  sections: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '14px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  wide: { gridColumn: '1 / -1' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' },
  component: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px auto', gap: '8px', alignItems: 'end' },
  messages: { marginBottom: '16px', ':empty': { marginBottom: 0 } },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: '12px', lineHeight: '17px' },
});

export function ProductFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const existing = useProduct(id);
  // "Keep my changes" after a conflict: the draft laid over the latest version, applied once the form is rebuilt from it.
  const [carried, setCarried] = useState<ProductDraft | null>(null);
  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  if (id && !existing.data) return <Spinner label={t('common.loading')} />;
  return (
    <ProductForm
      key={existing.data?.etag ?? 'new'}
      id={id}
      initial={existing.data?.data}
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

interface ComponentRow {
  key: number;
  product: ProductListItem | null;
  quantity: string;
}

function draftOf(initial: Product | undefined) {
  return {
    values: {
      sku: initial?.sku ?? '',
      name: initial?.name ?? '',
      nameEn: initial?.nameEn ?? '',
      description: initial?.description ?? '',
      type: (initial?.type ?? 'ManagedService') as ProductType,
      businessLine: (initial?.businessLine ?? 'Atera') as BusinessLine,
      unit: (initial?.unit ?? 'Device') as ProductUnit,
      billingPeriod: (initial?.billingPeriod ?? 'Monthly') as BillingPeriod,
      vatRate: String(initial?.vatRate ?? 25),
      listPrice: initial ? String(initial.listPrice) : '',
      unitCost: initial?.unitCost != null ? String(initial.unitCost) : '',
      microsoftOfferId: initial?.microsoftOfferId ?? '',
      commitmentTerm: (initial?.commitmentTerm ?? 'P1Y') as CommitmentTerm,
      ateraWorkType: initial?.ateraWorkType ?? '',
      revenueAccount: initial?.revenueAccount ?? '',
    },
    components: (initial?.components ?? []).map(
      (c, i): ComponentRow => ({
        key: i,
        quantity: String(c.quantity),
        product: { id: c.productId, sku: c.sku ?? '', name: c.name ?? '', type: 'ManagedService', businessLine: 'Other', unit: 'Piece', billingPeriod: 'Monthly', listPrice: 0, currency: 'NOK', isActive: true },
      }),
    ),
  };
}

type ProductDraft = ReturnType<typeof draftOf>;

interface ProductFormProps {
  id?: string;
  initial?: Product;
  etag: string | null;
  carried: ProductDraft | null;
  onReload: () => void;
  onKeepMine: (draft: ProductDraft) => void;
}

function ProductForm({ id, initial, etag, carried, onReload, onKeepMine }: ProductFormProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const save = useSaveProduct(id);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const base = useMemo(() => draftOf(initial), [initial]);
  const start = carried ?? base;
  const [values, setValues] = useState(start.values);
  const [components, setComponents] = useState<ComponentRow[]>(start.components);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));

  const draft: ProductDraft = { values, components };
  const { blocker, markSaved } = useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(base));
  const conflictError = save.error instanceof ApiError && save.error.status === 412 ? save.error : null;
  const conflictFlow = useConflictFlow<ProductDraft>({
    conflict: conflictError,
    base,
    getMine: () => draft,
    readLatest: async () => draftOf((await api.get<Product>(`/api/v1/catalog/products/${id}`)).data),
    labelOf: (path) => (path.startsWith('values.') ? t(`catalog.fields.${path.split('.')[1]}`) : t('catalog.sections.bundle')),
  });

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!values.sku.trim()) next.sku = t('errors.validation');
    if (!values.name.trim()) next.name = t('errors.validation');
    const listPrice = parseDecimal(values.listPrice);
    if (listPrice === null || Number.isNaN(listPrice) || listPrice < 0) next.listPrice = t('catalog.form.invalidAmount');
    const unitCost = parseDecimal(values.unitCost);
    if (Number.isNaN(unitCost) || (unitCost !== null && unitCost < 0)) next.unitCost = t('catalog.form.invalidAmount');
    const parts = components.filter((c) => c.product).map((c) => ({ productId: c.product!.id, quantity: parseDecimal(c.quantity) ?? 0 }));
    if (values.type === 'Bundle' && parts.length === 0) next.components = t('catalog.form.bundleEmpty');
    if (parts.some((p) => !(p.quantity > 0))) next.components = t('catalog.form.invalidAmount');
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      const response = await save.mutateAsync({
        etag,
        request: {
          sku: values.sku.trim(),
          name: values.name.trim(),
          nameEn: blankToNull(values.nameEn),
          description: blankToNull(values.description),
          type: values.type,
          businessLine: values.businessLine,
          unit: values.unit,
          billingPeriod: values.billingPeriod,
          vatRate: Number(values.vatRate),
          listPrice: listPrice!,
          unitCost,
          currency: 'NOK',
          microsoftOfferId: values.type === 'MicrosoftLicense' ? blankToNull(values.microsoftOfferId) : null,
          commitmentTerm: values.type === 'MicrosoftLicense' ? values.commitmentTerm : 'None',
          ateraWorkType: blankToNull(values.ateraWorkType),
          revenueAccount: blankToNull(values.revenueAccount),
          components: values.type === 'Bundle' ? parts : [],
        },
      });
      notify(id ? t('catalog.form.saved') : t('catalog.form.created'));
      markSaved();
      navigate(`/catalog/products/${response.data.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CAT_DUPLICATE_SKU') setErrors({ sku: t('catalog.form.duplicateSku') });
      else if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  const text = (key: 'sku' | 'name' | 'nameEn' | 'microsoftOfferId' | 'ateraWorkType' | 'revenueAccount', props: { required?: boolean; hint?: string; className?: string } = {}) => (
    <Field label={t(`catalog.fields.${key}`)} required={props.required} hint={props.hint} className={props.className} validationState={errors[key] ? 'error' : 'none'} validationMessage={errors[key]}>
      <Input value={values[key]} onChange={(_, d) => set(key, d.value)} />
    </Field>
  );

  const choice = <K extends 'type' | 'businessLine' | 'unit' | 'billingPeriod' | 'commitmentTerm'>(key: K, options: readonly string[], labelPrefix: string) => (
    <Field label={t(`catalog.fields.${key}`)} required>
      <Dropdown value={t(`${labelPrefix}.${values[key]}`)} selectedOptions={[values[key]]} onOptionSelect={(_, d) => set(key, d.optionValue as (typeof values)[K])}>
        {options.map((o) => (
          <Option key={o} value={o}>
            {t(`${labelPrefix}.${o}`)}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );

  const conflict = save.error instanceof ApiError && save.error.status === 412;
  const otherError = save.error && !(save.error instanceof ApiError && [400, 409, 412].includes(save.error.status));
  const cancelTo = id ? `/catalog/products/${id}` : '/catalog';

  return (
    <>
      <UnsavedChangesDialog blocker={blocker} />
      <PageHeader title={id ? t('catalog.form.editTitle', { name: initial?.name }) : t('catalog.products.new')} back={{ to: cancelTo, label: t('common.back') }} />
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
        <Panel title={t('catalog.sections.product')} icon={<Box16Regular />}>
          <div className={styles.grid}>
            {text('sku', { required: true, hint: t('catalog.form.skuHint') })}
            {choice('type', productTypes, 'catalog.types')}
            {text('name', { required: true, className: styles.wide })}
            {text('nameEn', { className: styles.wide })}
            <Field label={t('catalog.fields.description')} className={styles.wide}>
              <Textarea value={values.description} onChange={(_, d) => set('description', d.value)} resize="vertical" />
            </Field>
            {choice('businessLine', businessLines, 'catalog.businessLines')}
            {choice('unit', productUnits, 'catalog.units')}
          </div>
        </Panel>

        <Panel title={t('catalog.sections.pricing')} icon={<Money16Regular />}>
          <div className={styles.grid}>
            <Field label={t('catalog.fields.listPrice')} required hint={t('catalog.form.listPriceHint')} validationState={errors.listPrice ? 'error' : 'none'} validationMessage={errors.listPrice}>
              <Input inputMode="decimal" value={values.listPrice} onChange={(_, d) => set('listPrice', d.value)} contentAfter="NOK" />
            </Field>
            {canSeeCost && (
              <Field label={t('catalog.fields.unitCost')} validationState={errors.unitCost ? 'error' : 'none'} validationMessage={errors.unitCost}>
                <Input inputMode="decimal" value={values.unitCost} onChange={(_, d) => set('unitCost', d.value)} contentAfter="NOK" />
              </Field>
            )}
            {choice('billingPeriod', billingPeriods, 'catalog.periods')}
            <Field label={t('catalog.fields.vatRate')} required>
              <Dropdown value={`${values.vatRate} %`} selectedOptions={[values.vatRate]} onOptionSelect={(_, d) => set('vatRate', d.optionValue ?? '25')}>
                {vatRates.map((r) => (
                  <Option key={r} value={String(r)}>{`${r} %`}</Option>
                ))}
              </Dropdown>
            </Field>
          </div>
        </Panel>

        {values.type === 'MicrosoftLicense' && (
          <Panel title={t('catalog.sections.microsoft')} icon={<Cloud16Regular />}>
            <div className={styles.grid}>
              {text('microsoftOfferId', { hint: t('catalog.form.offerIdHint') })}
              {choice('commitmentTerm', commitmentTerms, 'catalog.terms')}
            </div>
          </Panel>
        )}

        {values.type === 'Bundle' && (
          <Panel title={t('catalog.sections.bundle')} icon={<BoxMultiple20Regular />}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {components.map((row, index) => (
                <div key={row.key} className={styles.component}>
                  <Field label={index === 0 ? t('catalog.fields.product') : undefined} aria-label={t('catalog.fields.product')}>
                    <ProductPicker
                      value={row.product}
                      exclude={id ? [id] : []}
                      onChange={(product) => setComponents((rows) => rows.map((r) => (r.key === row.key ? { ...r, product } : r)))}
                    />
                  </Field>
                  <Field label={index === 0 ? t('catalog.fields.quantity') : undefined}>
                    <Input
                      inputMode="decimal"
                      aria-label={t('catalog.fields.quantity')}
                      value={row.quantity}
                      onChange={(_, d) => setComponents((rows) => rows.map((r) => (r.key === row.key ? { ...r, quantity: d.value } : r)))}
                    />
                  </Field>
                  <Button
                    appearance="subtle"
                    icon={<Delete20Regular />}
                    aria-label={t('catalog.form.removeComponent')}
                    onClick={() => setComponents((rows) => rows.filter((r) => r.key !== row.key))}
                  />
                </div>
              ))}
              {errors.components && <span className={styles.error} role="alert">{errors.components}</span>}
              <div>
                <Button onClick={() => setComponents((rows) => [...rows, { key: Date.now(), product: null, quantity: '1' }])}>{t('catalog.form.addComponent')}</Button>
              </div>
            </div>
          </Panel>
        )}

        <Panel title={t('catalog.sections.mapping')} icon={<ArrowSync16Regular />}>
          <div className={styles.grid}>
            {text('ateraWorkType', { hint: t('catalog.form.ateraWorkTypeHint') })}
            {text('revenueAccount', { hint: t('catalog.form.revenueAccountHint') })}
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
