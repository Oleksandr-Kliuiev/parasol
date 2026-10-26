import { Link, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, mergeClasses } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { ListFooter } from '../../shared/components/ListFooter';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../catalog/styles';
import { InvoiceMovements, InvoiceStatusBadge } from './shared';
import type { Invoice } from './types';

const useStyles = makeStyles({
  table: {
    // Column widths include the cell padding; the customer takes what the figures leave.
    '& th': { boxSizing: 'border-box' },
    '& td': { paddingTop: '10px', paddingBottom: '10px' },
  },
  numberColumn: { width: '13%' },
  datesColumn: { width: '136px' },
  moneyColumn: { width: '152px' },
  // The remaining amount carries the balance movements under it: the widest figure column.
  outstandingColumn: { width: '288px' },
  statusColumn: { width: '176px' },
  number: { fontWeight: 600 },
  label: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  hidden: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  small: { fontSize: '12.5px', lineHeight: '18px' },
  warn: { color: h.emberT },
  // Phones: one row per invoice, the figures on the right as in the reference's record rows.
  list: { listStyleType: 'none', margin: 0, padding: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    columnGap: '12px',
    rowGap: '4px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  rowMain: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  rowEnd: { display: 'grid', justifyItems: 'end', alignContent: 'start', gap: '4px', textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  amount: { fontWeight: 600, whiteSpace: 'nowrap' },
  movements: { gridColumn: '1 / -1' },
});

interface InvoiceListProps {
  invoices: Invoice[];
  canSeeMoney: boolean;
  /** The customer column of the invoice list; a customer's own tab leaves it out. */
  showCustomer: boolean;
  total?: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
}

function InvoiceNumber({ invoice }: { invoice: Invoice }) {
  const styles = useStyles();
  return invoice.url ? (
    <Link href={safeHttpUrl(invoice.url)} target="_blank" rel="noopener noreferrer" className={styles.number}>
      {invoice.invoiceNo}
    </Link>
  ) : (
    <span className={styles.number}>{invoice.invoiceNo}</span>
  );
}

/** Invoices as a table on wide screens and as rows on phones, ended by the shared list footer (DEV-12). */
export function InvoiceList({ invoices, canSeeMoney, showCustomer, total, hasMore, loadingMore, onMore }: InvoiceListProps) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_SCREEN);
  const footer = <ListFooter shown={invoices.length} total={total} hasMore={hasMore} loading={loadingMore} onMore={onMore} />;

  if (narrow) {
    return (
      <div className={catalog.tableWrap}>
        <ul className={styles.list} aria-label={t('invoices.title')}>
          {invoices.map((invoice) => (
            <li key={invoice.id} className={styles.row}>
              <span className={styles.rowMain}>
                <InvoiceNumber invoice={invoice} />
                {showCustomer && (invoice.organization ? (
                  <AppLink to={`/organizations/${invoice.organization.id}?tab=invoices`}>{invoice.organization.name}</AppLink>
                ) : (
                  <span className={styles.label}>{t('invoices.noCustomer')}</span>
                ))}
                <span className={styles.label}>
                  {[formatDate(invoice.invoiceDate), invoice.dueDate ? t('invoices.due', { date: formatDate(invoice.dueDate) }) : null].filter(Boolean).join(' · ')}
                </span>
                {invoice.basisId && <AppLink to={`/billing/bases/${invoice.basisId}`} className={styles.small}>{t('invoices.openBasis')}</AppLink>}
              </span>
              <span className={styles.rowEnd}>
                <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
                {/* Two amounts on a phone row: each says what it is (WCAG 1.3.1). */}
                {canSeeMoney && <span className={mergeClasses(styles.amount, invoice.isOverdue && styles.warn)}>
                  <span className={styles.hidden}>{t('invoices.outstanding')}: </span>{formatMoney(invoice.outstanding)}</span>}
                {canSeeMoney && <span className={styles.label}>{t('invoices.totalOf', { amount: formatMoney(invoice.totalIncVat) })}</span>}
              </span>
              {canSeeMoney && invoice.movements.length > 0 && (
                <span className={styles.movements}><InvoiceMovements movements={invoice.movements} canSeeMoney={canSeeMoney} /></span>
              )}
            </li>
          ))}
        </ul>
        {footer}
      </div>
    );
  }

  return (
    <ScrollTable className={catalog.tableWrap}>
      <Table className={mergeClasses(catalog.table, styles.table)} aria-label={t('invoices.title')}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell className={styles.numberColumn}>{t('invoices.fields.number')}</TableHeaderCell>
            {showCustomer && <TableHeaderCell>{t('invoices.fields.customer')}</TableHeaderCell>}
            <TableHeaderCell className={styles.datesColumn}>{t('invoices.fields.dates')}</TableHeaderCell>
            {canSeeMoney && <TableHeaderCell className={mergeClasses(catalog.number, styles.moneyColumn)}>{t('invoices.fields.total')}</TableHeaderCell>}
            {canSeeMoney && <TableHeaderCell className={mergeClasses(catalog.number, styles.outstandingColumn)}>{t('invoices.fields.outstanding')}</TableHeaderCell>}
            <TableHeaderCell className={styles.statusColumn}>{t('common.status')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => (
            <TableRow key={invoice.id}>
              <TableCell>
                <InvoiceNumber invoice={invoice} />
                {invoice.basisId && (
                  <div className={styles.label}>
                    <AppLink to={`/billing/bases/${invoice.basisId}`}>{t('invoices.openBasis')}</AppLink>
                  </div>
                )}
              </TableCell>
              {showCustomer && (
                <TableCell>
                  {invoice.organization ? (
                    <AppLink to={`/organizations/${invoice.organization.id}?tab=invoices`}>{invoice.organization.name}</AppLink>
                  ) : (
                    <span className={styles.label}>{t('invoices.noCustomer')}</span>
                  )}
                </TableCell>
              )}
              <TableCell className="tabular">
                {formatDate(invoice.invoiceDate)}
                <div className={styles.label}>{invoice.dueDate ? t('invoices.due', { date: formatDate(invoice.dueDate) }) : '—'}</div>
              </TableCell>
              {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(invoice.totalIncVat)}</TableCell>}
              {canSeeMoney && (
                <TableCell className={catalog.number}>
                  <span className={invoice.isOverdue ? styles.warn : undefined}>{formatMoney(invoice.outstanding)}</span>
                  <InvoiceMovements movements={invoice.movements} canSeeMoney={canSeeMoney} />
                </TableCell>
              )}
              <TableCell>
                <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {footer}
    </ScrollTable>
  );
}
