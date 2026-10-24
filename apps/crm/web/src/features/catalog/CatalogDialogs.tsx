import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
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
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Dialog } from '../../shared/components/Dialog';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { parseDecimal, todayIso } from '../../shared/utils/format';
import { useCategories, usePriceListActions, useSaveCategory } from './api';
import { useCatalogStyles } from './styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import type { CustomerCategory } from './types';

export function PriceListStatusBadge({ status, current }: { status: 'Draft' | 'Active'; current?: boolean }) {
  const { t } = useTranslation();
  if (status === 'Draft') return <Badge appearance="tint" color="informative">{t('catalog.priceLists.draft')}</Badge>;
  return (
    <Badge appearance="tint" color={current ? 'success' : 'brand'}>
      {current ? t('catalog.priceLists.current') : t('catalog.priceLists.active')}
    </Badge>
  );
}

interface PriceListDialogProps {
  open: boolean;
  onClose: () => void;
  existing?: { id: string; name: string; customerCategory: string; validFrom: string; validTo: string | null; currency: string; etag: string | null };
}

export function PriceListDialog({ open, onClose, existing }: PriceListDialogProps) {
  // The form mounts with the surface, once per opening, and stays while the dialog leaves.
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface><PriceListForm onClose={onClose} existing={existing} /></DialogSurface>
    </Dialog>
  );
}

function PriceListForm({ onClose, existing }: Omit<PriceListDialogProps, 'open'>) {
  const styles = useCatalogStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const categories = useCategories();
  const actions = usePriceListActions(existing?.id);
  const defaultCategory = categories.data?.find((c) => c.isDefault)?.code ?? categories.data?.[0]?.code ?? '';
  const [values, setValues] = useState({
    name: existing?.name ?? '',
    customerCategory: existing?.customerCategory ?? '',
    validFrom: existing?.validFrom ?? `${todayIso().slice(0, 4)}-01-01`,
    validTo: existing?.validTo ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const category = values.customerCategory || defaultCategory;

  const submit = async () => {
    if (!values.name.trim()) {
      setErrors({ name: t('errors.validation') });
      return;
    }
    try {
      const response = await actions.save.mutateAsync({
        request: { name: values.name.trim(), customerCategory: category, validFrom: values.validFrom, validTo: values.validTo || null, currency: existing?.currency ?? 'NOK' },
        etag: existing?.etag,
      });
      notify(existing ? t('catalog.priceLists.saved') : t('catalog.priceLists.created'));
      onClose();
      if (!existing) navigate(`/catalog/price-lists/${response.data.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{existing ? t('catalog.priceLists.editTitle') : t('catalog.priceLists.new')}</DialogTitle>
        <DialogContent>
          {actions.save.error && !(actions.save.error instanceof ApiError && actions.save.error.status === 400) && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(actions.save.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('catalog.fields.name')} required className={styles.wide} validationMessage={errors.name}>
              <Input value={values.name} onChange={(_, d) => setValues((v) => ({ ...v, name: d.value }))} />
            </Field>
            <Field label={t('catalog.fields.category')} required className={styles.wide}>
              <Dropdown
                value={categories.data?.find((c) => c.code === category)?.name ?? category}
                selectedOptions={[category]}
                onOptionSelect={(_, d) => setValues((v) => ({ ...v, customerCategory: d.optionValue ?? '' }))}
              >
                {(categories.data ?? []).map((c) => (
                  <Option key={c.code} value={c.code} text={c.name}>
                    {c.name} ({c.code})
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('catalog.fields.validFrom')} required validationMessage={errors.validFrom}>
              <Input type="date" value={values.validFrom} onChange={(_, d) => setValues((v) => ({ ...v, validFrom: d.value }))} />
            </Field>
            <Field label={t('catalog.fields.validTo')} hint={t('catalog.openEndedHint')} validationMessage={errors.validTo}>
              <Input type="date" value={values.validTo} onChange={(_, d) => setValues((v) => ({ ...v, validTo: d.value }))} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={actions.save.isPending || !category}>
            {existing ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Creates a customer category (`existing` null) or edits one. */
export function CategoryDialog({ open, existing, onClose }: { open: boolean; existing: CustomerCategory | null; onClose: () => void }) {
  // The form mounts with the surface, once per opening, and keeps its category while the dialog leaves.
  const shown = useKeptWhileClosing(existing, open);
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface><CategoryForm existing={shown} onClose={onClose} /></DialogSurface>
    </Dialog>
  );
}

function CategoryForm({ existing, onClose }: { existing: CustomerCategory | null; onClose: () => void }) {
  const styles = useCatalogStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const save = useSaveCategory();
  const [code, setCode] = useState(existing?.code ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [markup, setMarkup] = useState(existing ? String(existing.licenseMarkupPct) : '15');
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const markupValue = parseDecimal(markup);
  const invalid = !code.trim() || !name.trim() || markupValue === null || Number.isNaN(markupValue);

  const submit = async () => {
    if (invalid) return;
    try {
      await save.mutateAsync({ id: existing?.id, etag: existing?.etag, code: code.trim(), name: name.trim(), licenseMarkupPct: markupValue, isDefault });
      notify(t('catalog.categories.saved'));
      onClose();
    } catch {
      // Shown below.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{existing ? t('catalog.categories.editTitle') : t('catalog.categories.new')}</DialogTitle>
        <DialogContent>
          {save.error && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('catalog.fields.code')} required hint={t('catalog.categories.codeHint')}>
              <Input value={code} disabled={Boolean(existing)} onChange={(_, d) => setCode(d.value)} />
            </Field>
            <Field label={t('catalog.fields.name')} required>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('catalog.fields.licenseMarkupPct')} hint={t('catalog.categories.markupHint')}>
              <Input inputMode="decimal" value={markup} onChange={(_, d) => setMarkup(d.value)} contentAfter="%" />
            </Field>
            <Switch className={styles.controlRow} label={t('catalog.categories.makeDefault')} checked={isDefault} disabled={existing?.isDefault} onChange={(_, d) => setIsDefault(d.checked)} />
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || save.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
