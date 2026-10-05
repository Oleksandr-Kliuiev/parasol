import { useSearchParams } from 'react-router';
import {
  Link,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useInvoicePages } from './api';
import { InvoiceStatusBadge } from './shared';
import { SavedViews } from '../../shared/views/SavedViews';

const useStyles = makeStyles({
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  scope: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, marginTop: `-${tokens.spacingVerticalM}`, marginBottom: tokens.spacingVerticalL },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warn: { color: tokens.colorPaletteRedForeground1 },
});

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

  const setFlag = (key: string, value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, 'true');
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title={t('invoices.title')} subtitle={t('invoices.subtitle')} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
        <SavedViews scope="invoices" keys={['open', 'overdue']} />
      </div>

      {canSeeMoney && (
        <div className={styles.tiles}>
          <div className={styles.tile}>
            <span className={styles.value}>{formatMoney(data?.outstanding)}</span>
            <span className={styles.label}>{t('invoices.outstanding')}</span>
          </div>
          <div className={styles.tile}>
            <span className={`${styles.value} ${(data?.overdue ?? 0) > 0 ? styles.warn : ''}`}>{formatMoney(data?.overdue)}</span>
            <span className={styles.label}>{t('invoices.overdue')}</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.value}>{data?.count ?? 0}</span>
            <span className={styles.label}>{t('invoices.count')}</span>
          </div>
        </div>
      )}
      {canSeeMoney && data && <Text block className={styles.scope}>{t('invoices.totalsScope', { count: data.count, date: formatDate(data.asOf) })}</Text>}

      <div className={catalog.filters}>
        <Switch label={t('invoices.openOnly')} checked={openOnly} onChange={(_, d) => setFlag('open', d.checked)} />
        <Switch label={t('invoices.overdueOnly')} checked={overdueOnly} onChange={(_, d) => setFlag('overdue', d.checked)} />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('invoices.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('invoices.fields.number')}</TableHeaderCell>
                <TableHeaderCell>{t('invoices.fields.customer')}</TableHeaderCell>
                <TableHeaderCell>{t('invoices.fields.dates')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('invoices.fields.total')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('invoices.fields.outstanding')}</TableHeaderCell>}
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    {invoice.url ? (
                      <Link href={invoice.url} target="_blank" rel="noopener noreferrer">
                        {invoice.invoiceNo}
                      </Link>
                    ) : (
                      <Text weight="semibold">{invoice.invoiceNo}</Text>
                    )}
                    {invoice.basisId && (
                      <div className={styles.label}>
                        <AppLink to={`/billing/bases/${invoice.basisId}`}>{t('invoices.openBasis')}</AppLink>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {invoice.organization ? (
                      <AppLink to={`/organizations/${invoice.organization.id}?tab=invoices`}>{invoice.organization.name}</AppLink>
                    ) : (
                      <span className={styles.label}>{t('invoices.noCustomer')}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular">
                    {formatDate(invoice.invoiceDate)}
                    <div className={styles.label}>{invoice.dueDate ? t('invoices.due', { date: formatDate(invoice.dueDate) }) : '—'}</div>
                  </TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(invoice.totalIncVat)}</TableCell>}
                  {canSeeMoney && (
                    <TableCell className={catalog.number}>
                      <span className={invoice.isOverdue ? styles.warn : undefined}>{formatMoney(invoice.outstanding)}</span>
                    </TableCell>
                  )}
                  <TableCell>
                    <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && invoices.length === 0 && <EmptyState message={t('invoices.empty')} />}
          <ListFooter shown={invoices.length} total={data?.count} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
        </div>
      )}
    </>
  );
}

/** Invoices and balance of one customer (docs/02 §4.2, tab "Invoices"). */
export function OrganizationInvoicesTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
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
      {canSeeMoney && (data?.count ?? 0) > 0 && (
        <div className={styles.tiles}>
          <div className={styles.tile}>
            <span className={styles.value}>{formatMoney(data?.outstanding)}</span>
            <span className={styles.label}>{t('invoices.outstanding')}</span>
          </div>
          <div className={styles.tile}>
            <span className={`${styles.value} ${(data?.overdue ?? 0) > 0 ? styles.warn : ''}`}>{formatMoney(data?.overdue)}</span>
            <span className={styles.label}>{t('invoices.overdue')}</span>
          </div>
        </div>
      )}
      {canSeeMoney && data && data.count > 0 && <Text block className={styles.scope}>{t('invoices.totalsScope', { count: data.count, date: formatDate(data.asOf) })}</Text>}
      <div className={catalog.tableWrap}>
        <Table className={catalog.table} aria-label={t('invoices.title')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('invoices.fields.number')}</TableHeaderCell>
              <TableHeaderCell>{t('invoices.fields.dates')}</TableHeaderCell>
              {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('invoices.fields.total')}</TableHeaderCell>}
              {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('invoices.fields.outstanding')}</TableHeaderCell>}
              <TableHeaderCell>{t('common.status')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((invoice) => (
              <TableRow key={invoice.id}>
                <TableCell>
                  {invoice.url ? (
                    <Link href={invoice.url} target="_blank" rel="noopener noreferrer">
                      {invoice.invoiceNo}
                    </Link>
                  ) : (
                    <Text weight="semibold">{invoice.invoiceNo}</Text>
                  )}
                </TableCell>
                <TableCell className="tabular">
                  {formatDate(invoice.invoiceDate)}
                  <div className={styles.label}>{invoice.dueDate ? t('invoices.due', { date: formatDate(invoice.dueDate) }) : '—'}</div>
                </TableCell>
                {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(invoice.totalIncVat)}</TableCell>}
                {canSeeMoney && (
                  <TableCell className={catalog.number}>
                    <span className={invoice.isOverdue ? styles.warn : undefined}>{formatMoney(invoice.outstanding)}</span>
                  </TableCell>
                )}
                <TableCell>
                  <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!isPending && invoices.length === 0 && <EmptyState message={t('invoices.emptyForOrganization')} />}
        <ListFooter shown={invoices.length} total={data?.count} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </div>
    </>
  );
}
