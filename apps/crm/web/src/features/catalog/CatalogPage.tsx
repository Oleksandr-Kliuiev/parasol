import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
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
  SearchBox,
  Skeleton,
  SkeletonItem,
  Switch,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCategories, usePriceListActions, usePriceLists, useProducts, useSaveCategory } from './api';
import { useCatalogStyles } from './styles';
import { productTypes, type CustomerCategory, type ProductType } from './types';


type TabValue = 'products' | 'price-lists' | 'categories';

export function CatalogPage() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabValue | null) ?? 'products';

  return (
    <>
      <PageHeader title={t('catalog.title')} subtitle={t('catalog.subtitle')} />
      <TabList className={styles.tabs} selectedValue={tab} onTabSelect={(_, d) => setParams(d.value === 'products' ? {} : { tab: String(d.value) }, { replace: true })}>
        <Tab value="products">{t('catalog.tabs.products')}</Tab>
        <Tab value="price-lists">{t('catalog.tabs.priceLists')}</Tab>
        <Tab value="categories">{t('catalog.tabs.categories')}</Tab>
      </TabList>
      {tab === 'products' && <ProductsTab />}
      {tab === 'price-lists' && <PriceListsTab />}
      {tab === 'categories' && <CategoriesTab />}
    </>
  );
}

function ProductsTab() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.catalogWrite);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [search, setSearch] = useState('');
  const [type, setType] = useState<ProductType | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const debounced = useDebouncedValue(search.trim());
  const { data, error, isPending, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useProducts({
    search: debounced,
    type,
    active: showInactive ? null : true,
  });
  const rows = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className={styles.filters}>
        <SearchBox
          id="products-search"
          className={styles.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('catalog.products.search')}
          aria-label={t('catalog.products.search')}
        />
        <Field label={t('catalog.fields.type')}>
          <Dropdown
            value={type ? t(`catalog.types.${type}`) : t('common.all')}
            selectedOptions={[type ?? '']}
            onOptionSelect={(_, d) => setType((d.optionValue as ProductType) || null)}
          >
            <Option value="">{t('common.all')}</Option>
            {productTypes.map((p) => (
              <Option key={p} value={p}>
                {t(`catalog.types.${p}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Switch label={t('catalog.products.showInactive')} checked={showInactive} onChange={(_, d) => setShowInactive(d.checked)} />
        <span style={{ flex: 1 }} />
        {canWrite && (
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/catalog/products/new')}>
            {t('catalog.products.new')}
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : narrow ? (
        <ul className={styles.cards} aria-label={t('catalog.tabs.products')}>
          {rows.map((p) => (
            <li key={p.id} className={styles.card}>
              <AppLink to={`/catalog/products/${p.id}`} className={styles.name}>
                {p.name}
              </AppLink>
              <span className={styles.cardMeta}>
                <span className={styles.sku}>{p.sku}</span>
                <span>{t(`catalog.types.${p.type}`)}</span>
                <span className="tabular">
                  {formatMoney(p.listPrice, p.currency)} / {t(`catalog.units.${p.unit}`)}
                </span>
                {!p.isActive && <Badge appearance="outline" color="informative">{t('catalog.inactive')}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('catalog.tabs.products')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
                <TableHeaderCell>{t('catalog.fields.type')}</TableHeaderCell>
                <TableHeaderCell>{t('catalog.fields.billingPeriod')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('catalog.fields.listPrice')}</TableHeaderCell>
                {canSeeCost && <TableHeaderCell className={styles.number}>{t('catalog.fields.unitCost')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <AppLink to={`/catalog/products/${p.id}`} className={styles.name}>
                      {p.name}
                    </AppLink>{' '}
                    {!p.isActive && <Badge appearance="outline" color="informative">{t('catalog.inactive')}</Badge>}
                    <div className={styles.sku}>{p.sku}</div>
                  </TableCell>
                  <TableCell>{t(`catalog.types.${p.type}`)}</TableCell>
                  <TableCell>{t(`catalog.periods.${p.billingPeriod}`)}</TableCell>
                  <TableCell className={styles.number}>
                    {formatMoney(p.listPrice, p.currency)} <span className={styles.muted}>/ {t(`catalog.units.${p.unit}`)}</span>
                  </TableCell>
                  {canSeeCost && <TableCell className={styles.number}>{formatMoney(p.unitCost, p.currency)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
      {!isPending && !error && rows.length === 0 && <EmptyState message={debounced || type ? t('catalog.products.empty') : t('catalog.products.emptyAll')} />}
      {hasNextPage && (
        <div className={styles.more}>
          <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </>
  );
}

function PriceListsTab() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.catalogWrite);
  const { data = [], error, isPending, refetch } = usePriceLists();
  const [creating, setCreating] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <div className={styles.filters}>
        <span className={styles.muted} style={{ flex: 1 }}>{t('catalog.priceLists.explainer')}</span>
        {canWrite && (
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setCreating(true)}>
            {t('catalog.priceLists.new')}
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('catalog.tabs.priceLists')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
                <TableHeaderCell>{t('catalog.fields.category')}</TableHeaderCell>
                <TableHeaderCell>{t('catalog.fields.period')}</TableHeaderCell>
                <TableHeaderCell>{t('catalog.fields.status')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('catalog.priceLists.items')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <AppLink to={`/catalog/price-lists/${l.id}`} className={styles.name}>
                      {l.name}
                    </AppLink>
                  </TableCell>
                  <TableCell>{l.customerCategory}</TableCell>
                  <TableCell className="tabular">
                    {formatDate(l.validFrom)} – {l.validTo ? formatDate(l.validTo) : t('catalog.openEnded')}
                  </TableCell>
                  <TableCell>
                    <PriceListStatusBadge status={l.status} current={l.isCurrent} />
                  </TableCell>
                  <TableCell className={styles.number}>{l.items}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
          {!isPending && data.length === 0 && <EmptyState message={t('catalog.priceLists.empty')} />}
        </div>
      )}
      <PriceListDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function PriceListStatusBadge({ status, current }: { status: 'Draft' | 'Active'; current?: boolean }) {
  const { t } = useTranslation();
  if (status === 'Draft') return <Badge appearance="outline" color="informative">{t('catalog.priceLists.draft')}</Badge>;
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
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>{open && <PriceListForm onClose={onClose} existing={existing} />}</DialogSurface>
    </Dialog>
  );
}

function PriceListForm({ onClose, existing }: Omit<PriceListDialogProps, 'open'>) {
  const styles = useCatalogStyles();
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
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
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

function CategoriesTab() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.catalogWrite);
  const { data = [], error, refetch } = useCategories();
  const [editing, setEditing] = useState<CustomerCategory | 'new' | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <div className={styles.filters}>
        <span className={styles.muted} style={{ flex: 1 }}>{t('catalog.categories.explainer')}</span>
        {canWrite && (
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setEditing('new')}>
            {t('catalog.categories.new')}
          </Button>
        )}
      </div>
      <div className={styles.tableWrap}>
        <Table className={styles.table} aria-label={t('catalog.tabs.categories')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
              <TableHeaderCell>{t('catalog.fields.code')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('catalog.fields.licenseMarkupPct')}</TableHeaderCell>
              {canWrite && <TableHeaderCell />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  {c.name} {c.isDefault && <Badge appearance="tint" color="brand">{t('catalog.categories.default')}</Badge>}
                </TableCell>
                <TableCell className={styles.sku}>{c.code}</TableCell>
                <TableCell className={styles.number}>{formatNumber(c.licenseMarkupPct)} %</TableCell>
                {canWrite && (
                  <TableCell>
                    <Button {...restoreFocusTarget} size="small" appearance="subtle" aria-label={t('catalog.categories.editNamed', { name: c.name })} onClick={() => setEditing(c)}>
                      {t('common.edit')}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}>
        <DialogSurface>{editing !== null && <CategoryForm existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}</DialogSurface>
      </Dialog>
    </>
  );
}

function CategoryForm({ existing, onClose }: { existing: CustomerCategory | null; onClose: () => void }) {
  const styles = useCatalogStyles();
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
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
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
            <Switch label={t('catalog.categories.makeDefault')} checked={isDefault} disabled={existing?.isDefault} onChange={(_, d) => setIsDefault(d.checked)} />
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
