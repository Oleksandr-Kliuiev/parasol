import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
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
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Delete20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
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
  sections: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '960px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  component: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px auto', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  messages: { marginBottom: tokens.spacingVerticalL },
});

export function ProductFormPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const existing = useProduct(id);
  if (id && existing.error) return <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />;
  if (id && !existing.data) return <Spinner label={t('common.loading')} />;
  return <ProductForm key={existing.data?.etag ?? 'new'} id={id} initial={existing.data?.data} etag={existing.data?.etag ?? null} onReload={() => void existing.refetch()} />;
}

interface ComponentRow {
  key: number;
  product: ProductListItem | null;
  quantity: string;
}

function ProductForm({ id, initial, etag, onReload }: { id?: string; initial?: Product; etag: string | null; onReload: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const save = useSaveProduct(id);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const [values, setValues] = useState({
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
  });
  const [components, setComponents] = useState<ComponentRow[]>(
    (initial?.components ?? []).map((c, i) => ({
      key: i,
      quantity: String(c.quantity),
      product: { id: c.productId, sku: c.sku ?? '', name: c.name ?? '', type: 'ManagedService', businessLine: 'Other', unit: 'Piece', billingPeriod: 'Monthly', listPrice: 0, currency: 'NOK', isActive: true },
    })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));

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
      <PageHeader title={id ? t('catalog.form.editTitle', { name: initial?.name }) : t('catalog.products.new')} back={{ to: cancelTo, label: t('common.back') }} />
      <div className={styles.messages} aria-live="polite">
        {conflict && (
          <MessageBar intent="error">
            <MessageBarBody>{t('errors.concurrency')}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={() => { save.reset(); onReload(); }}>
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
      </div>
      <form className={styles.sections} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Panel title={t('catalog.sections.product')}>
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

        <Panel title={t('catalog.sections.pricing')}>
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
          <Panel title={t('catalog.sections.microsoft')}>
            <div className={styles.grid}>
              {text('microsoftOfferId', { hint: t('catalog.form.offerIdHint') })}
              {choice('commitmentTerm', commitmentTerms, 'catalog.terms')}
            </div>
          </Panel>
        )}

        {values.type === 'Bundle' && (
          <Panel title={t('catalog.sections.bundle')}>
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
              {errors.components && <span style={{ color: tokens.colorPaletteRedForeground1 }}>{errors.components}</span>}
              <div>
                <Button onClick={() => setComponents((rows) => [...rows, { key: Date.now(), product: null, quantity: '1' }])}>{t('catalog.form.addComponent')}</Button>
              </div>
            </div>
          </Panel>
        )}

        <Panel title={t('catalog.sections.mapping')}>
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
