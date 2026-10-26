import { useSearchParams } from 'react-router';
import { Text, makeStyles } from '@fluentui/react-components';
import { Receipt16Regular, Receipt24Regular, Wallet16Regular, Warning16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterChips, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useInvoicePages } from './api';
import { InvoiceList } from './InvoiceList';
import { SavedViews } from '../../shared/views/SavedViews';
import { CustomerFinanceTab } from './CustomerFinanceTab';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useStatFitStyles } from './flushStyles';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  // What the tiles add up, on the line of the filters it depends on.
  scope: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', maxWidth: '62ch' },
});

type InvoiceFilter = 'all' | 'open' | 'overdue';

/** Invoices as PowerOffice reports them, with what is still outstanding (docs/02 §4.9). */
export function InvoicesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  const [params, setParams] = useSearchParams();
  const openOnly = params.get('open') === 'true';
  const overdueOnly = params.get('overdue') === 'true';
  const pages = useInvoicePages({ openOnly, overdueOnly });
  // The totals of the newest answer: they cover every invoice the filter matches, not the rows loaded so far.
  const data = pages.data?.pages.at(-1);
  const invoices = pages.data?.pages.flatMap((p) => p.invoices) ?? [];
  const { error, isPending, refetch } = pages;

  // Overdue invoices are a part of the outstanding ones, so the two flags are one choice of three.
  const filter: InvoiceFilter = overdueOnly ? 'overdue' : openOnly ? 'open' : 'all';
  const setFilter = (value: InvoiceFilter) => {
    const next = new URLSearchParams(params);
    next.delete('open');
    next.delete('overdue');
    if (value !== 'all') next.set(value, 'true');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title={t('invoices.title')} subtitle={t('invoices.subtitle')} actions={<SavedViews scope="invoices" keys={['open', 'overdue']} />} />

      {canSeeMoney && <InvoiceTotals outstanding={data?.outstanding} overdue={data?.overdue} count={data?.count ?? 0} />}

      <Toolbar end={canSeeMoney && data && <Text className={styles.scope}>{t('invoices.totalsScope', { count: data.count, date: formatDate(data.asOf) })}</Text>}>
        <FilterChips<InvoiceFilter>
          label={t('invoices.filter.label')}
          value={filter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'open', label: t('invoices.filter.open') },
            { value: 'overdue', label: t('invoices.filter.overdue'), dot: h.ember },
          ]}
          onChange={setFilter}
        />
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isPending && invoices.length === 0 ? (
        <div className={catalog.tableWrap}>
          <EmptyState icon={<Receipt24Regular />} message={filter === 'all' ? t('invoices.empty') : t('invoices.emptyFiltered')} />
        </div>
      ) : (
        <InvoiceList invoices={invoices} canSeeMoney={canSeeMoney} showCustomer total={data?.count} hasMore={pages.hasNextPage}
          loadingMore={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      )}
    </>
  );
}

/** Outstanding and overdue money (and the number of invoices when given) as the page's key figures. */
function InvoiceTotals({ outstanding, overdue, count }: { outstanding?: number; overdue?: number; count?: number }) {
  const { t } = useTranslation();
  const stat = useStatFitStyles();
  return (
    <StatGrid className={stat.fit} label={t('invoices.totals')}>
      <StatTile className={stat.money} icon={<Wallet16Regular />} tone="iris" label={t('invoices.outstanding')} value={formatMoney(outstanding)} />
      <StatTile className={stat.money}
        icon={<Warning16Regular />}
        tone="ember"
        label={t('invoices.overdue')}
        value={formatMoney(overdue)}
        status={(overdue ?? 0) > 0 ? 'bad' : undefined}
      />
      {count !== undefined && <StatTile icon={<Receipt16Regular />} label={t('invoices.count')} value={count} />}
    </StatGrid>
  );
}

/** Invoices and balance of one customer (docs/02 §4.2, tab "Invoices"). */
export function OrganizationInvoicesTab({ organizationId }: { organizationId: string }) {
  const finance = useCan(Permissions.financeRead);
  return finance ? <CustomerFinanceTab organizationId={organizationId} /> : <OrganizationInvoiceSummary organizationId={organizationId} />;
}

function OrganizationInvoiceSummary({ organizationId }: { organizationId: string }) {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  const pages = useInvoicePages({ organizationId });
  const data = pages.data?.pages.at(-1);
  const invoices = pages.data?.pages.flatMap((p) => p.invoices) ?? [];
  const { error, isPending, refetch } = pages;

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      {canSeeMoney && (data?.count ?? 0) > 0 && <InvoiceTotals outstanding={data?.outstanding} overdue={data?.overdue} />}
      {!isPending && invoices.length === 0 ? (
        <div className={catalog.tableWrap}>
          <EmptyState icon={<Receipt24Regular />} message={t('invoices.emptyForOrganization')} />
        </div>
      ) : (
        <InvoiceList invoices={invoices} canSeeMoney={canSeeMoney} showCustomer={false} total={data?.count} hasMore={pages.hasNextPage}
          loadingMore={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      )}
    </>
  );
}
