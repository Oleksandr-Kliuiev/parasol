import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dropdown,
  Option,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Box16Regular, Box24Regular, People16Regular, People24Regular, Tag16Regular, Tag24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCategories, usePriceLists, useProducts } from './api';
import { CategoryDialog, PriceListDialog, PriceListStatusBadge } from './CatalogDialogs';
import { useCatalogStyles } from './styles';
import { productTypes, type CustomerCategory, type ProductType } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { ScrollTabList } from '../../shared/components/ScrollTabList';

const useStyles = makeStyles({
  type: { minWidth: '200px' },
});

type TabValue = 'products' | 'price-lists' | 'categories';

/** Products, price lists and customer categories; each tab's own "new" is the page's primary action while the tab is open. */
export function CatalogPage() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.catalogWrite);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabValue | null) ?? 'products';
  const [creating, setCreating] = useState<TabValue | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  const primary = {
    products: { label: t('catalog.products.new'), onClick: () => navigate('/catalog/products/new') },
    'price-lists': { label: t('catalog.priceLists.new'), onClick: () => setCreating('price-lists') },
    categories: { label: t('catalog.categories.new'), onClick: () => setCreating('categories') },
  }[tab];

  return (
    <>
      <PageHeader
        title={t('catalog.title')}
        subtitle={t('catalog.subtitle')}
        actions={
          canWrite && (
            <Button key={tab} {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={primary.onClick}>
              {primary.label}
            </Button>
          )
        }
      />
      <ScrollTabList className={styles.tabs} selectedValue={tab} onTabSelect={(_, d) => setParams(d.value === 'products' ? {} : { tab: String(d.value) }, { replace: true })}>
        <Tab value="products">{t('catalog.tabs.products')}</Tab>
        <Tab value="price-lists">{t('catalog.tabs.priceLists')}</Tab>
        <Tab value="categories">{t('catalog.tabs.categories')}</Tab>
      </ScrollTabList>
      {tab === 'products' && <ProductsTab />}
      {tab === 'price-lists' && <PriceListsTab />}
      {tab === 'categories' && <CategoriesTab />}
      <PriceListDialog open={creating === 'price-lists'} onClose={() => setCreating(null)} />
      <CategoryDialog open={creating === 'categories'} existing={null} onClose={() => setCreating(null)} />
    </>
  );
}

function ProductsTab() {
  const styles = useCatalogStyles();
  const local = useStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
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
  const filtered = Boolean(debounced || type);
  const empty = !isPending && rows.length === 0 && (
    <EmptyState icon={<Box24Regular />} message={filtered ? t('catalog.products.empty') : t('catalog.products.emptyAll')} />
  );
  const loading = isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>;
  const footer = (
    <ListFooter shown={rows.length} total={data?.pages.at(-1)?.totalCount ?? null} hasMore={Boolean(hasNextPage)} loading={isFetchingNextPage} onMore={() => void fetchNextPage()} />
  );

  return (
    <>
      <Toolbar label={t('catalog.products.filterLabel')}>
        <FilterField kind="search" label={t('catalog.products.search')}>
          <SearchBox id="products-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('catalog.products.search')} />
        </FilterField>
        <FilterField label={t('catalog.fields.type')}>
          <Dropdown
            className={local.type}
            value={type ? t(`catalog.types.${type}`) : t('catalog.products.allTypes')}
            selectedOptions={[type ?? '']}
            onOptionSelect={(_, d) => setType((d.optionValue as ProductType) || null)}
          >
            <Option value="">{t('catalog.products.allTypes')}</Option>
            {productTypes.map((p) => (
              <Option key={p} value={p}>
                {t(`catalog.types.${p}`)}
              </Option>
            ))}
          </Dropdown>
        </FilterField>
        <Switch className={styles.toggle} label={t('catalog.products.showInactive')} checked={showInactive} onChange={(_, d) => setShowInactive(d.checked)} />
      </Toolbar>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : narrow ? (
        <>
          {rows.length > 0 && (
            <ul className={record.cards} aria-label={t('catalog.tabs.products')}>
              {rows.map((p) => (
                <li key={p.id} className={record.card}>
                  <span className={record.cardMain}>
                    <RecordCell
                      icon={<Box16Regular />}
                      tone="spruce"
                      size={36}
                      name={<AppLink to={`/catalog/products/${p.id}`} className={styles.name}>{p.name}</AppLink>}
                      meta={[
                        <span className={styles.sku}>{p.sku}</span>,
                        t(`catalog.types.${p.type}`),
                        `${formatMoney(p.listPrice, p.currency)} / ${t(`catalog.units.${p.unit}`)}`,
                      ]}
                    />
                  </span>
                  {!p.isActive && (
                    <span className={record.cardEnd}>
                      <Badge appearance="tint" color="subtle">{t('catalog.inactive')}</Badge>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {loading}
          {empty && <div className={styles.emptyCard}>{empty}</div>}
          {footer}
        </>
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table className={styles.table} style={{ minWidth: 900 }} aria-label={t('catalog.tabs.products')}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; the name takes the rest. */}
                <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 166 }}>{t('catalog.fields.type')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 126 }}>{t('catalog.fields.billingPeriod')}</TableHeaderCell>
                <TableHeaderCell className={styles.number} style={{ width: 156 }}>{t('catalog.fields.listPrice')}</TableHeaderCell>
                {canSeeCost && <TableHeaderCell className={styles.number} style={{ width: 116 }}>{t('catalog.fields.unitCost')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <RecordCell
                      icon={<Box16Regular />}
                      tone="spruce"
                      name={
                        <>
                          <AppLink to={`/catalog/products/${p.id}`} className={styles.name}>
                            {p.name}
                          </AppLink>{' '}
                          {!p.isActive && <Badge appearance="tint" color="subtle">{t('catalog.inactive')}</Badge>}
                        </>
                      }
                      meta={[<span className={styles.sku}>{p.sku}</span>]}
                    />
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
          {loading}
          {empty}
          {footer}
        </ScrollTable>
      )}
    </>
  );
}

function PriceListsTab() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const { data = [], error, isPending, refetch } = usePriceLists();

  return (
    <>
      <Text as="p" className={styles.explainer}>{t('catalog.priceLists.explainer')}</Text>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table className={styles.table} style={{ minWidth: 840 }} aria-label={t('catalog.tabs.priceLists')}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; the name takes the rest. */}
                <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 136 }}>{t('catalog.fields.category')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 186 }}>{t('catalog.fields.period')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 106 }}>{t('catalog.fields.status')}</TableHeaderCell>
                <TableHeaderCell className={styles.number} style={{ width: 76 }}>{t('catalog.priceLists.items')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <RecordCell
                      icon={<Tag16Regular />}
                      tone="iris"
                      name={
                        <AppLink to={`/catalog/price-lists/${l.id}`} className={styles.name}>
                          {l.name}
                        </AppLink>
                      }
                    />
                  </TableCell>
                  <TableCell className={styles.sku}>{l.customerCategory}</TableCell>
                  <TableCell className="tabular">
                    {l.validTo ? `${formatDate(l.validFrom)} – ${formatDate(l.validTo)}` : t('catalog.from', { date: formatDate(l.validFrom) })}
                  </TableCell>
                  <TableCell>
                    <PriceListStatusBadge status={l.status} current={l.isCurrent} />
                  </TableCell>
                  <TableCell className={styles.number}>{formatNumber(l.items, 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
          {!isPending && data.length === 0 && <EmptyState icon={<Tag24Regular />} message={t('catalog.priceLists.empty')} />}
        </ScrollTable>
      )}
    </>
  );
}

function CategoriesTab() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.catalogWrite);
  const { data = [], error, isPending, refetch } = useCategories();
  const [editing, setEditing] = useState<CustomerCategory | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <Text as="p" className={styles.explainer}>{t('catalog.categories.explainer')}</Text>
      <ScrollTable className={styles.tableWrap}>
        <Table className={styles.table} aria-label={t('catalog.tabs.categories')}>
          <TableHeader>
            <TableRow>
              {/* Content widths: every cell adds 12 px of padding on each side; the name takes the rest. */}
              <TableHeaderCell>{t('catalog.fields.name')}</TableHeaderCell>
              <TableHeaderCell style={{ width: 136 }}>{t('catalog.fields.code')}</TableHeaderCell>
              <TableHeaderCell className={styles.number} style={{ width: 136 }}>{t('catalog.fields.licenseMarkupPct')}</TableHeaderCell>
              {canWrite && <TableHeaderCell style={{ width: 96 }} />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <RecordCell
                    icon={<People16Regular />}
                    name={<>{c.name} {c.isDefault && <Badge appearance="tint" color="brand">{t('catalog.categories.default')}</Badge>}</>}
                  />
                </TableCell>
                <TableCell className={styles.sku}>{c.code}</TableCell>
                <TableCell className={styles.number}>{formatNumber(c.licenseMarkupPct)} %</TableCell>
                {canWrite && (
                  <TableCell>
                    <span className={styles.rowActions}>
                      <Button {...restoreFocusTarget} size="small" appearance="subtle" aria-label={t('catalog.categories.editNamed', { name: c.name })} onClick={() => setEditing(c)}>
                        {t('common.edit')}
                      </Button>
                    </span>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
        {!isPending && data.length === 0 && <EmptyState icon={<People24Regular />} message={t('catalog.categories.empty')} />}
      </ScrollTable>
      <CategoryDialog open={editing !== null} existing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
