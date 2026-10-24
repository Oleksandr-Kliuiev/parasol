import { useRef, useState } from 'react';
import { Button, Spinner, Switch, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, mergeClasses } from '@fluentui/react-components';
import { Payment24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { useCustomerLedger } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';

interface CustomerLedgerPanelProps {
  organizationId: string;
  invoiceId?: string;
  onInvoice: (id: string) => void;
  /** Under its own tab the title would repeat the tab: it is read by screen readers only. */
  headingHidden?: boolean;
  /** The customer finance card has one Refresh of its own. */
  withRefresh?: boolean;
}

export function CustomerLedgerPanel({ organizationId, invoiceId, onInvoice, headingHidden = false, withRefresh = true }: CustomerLedgerPanelProps) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const [paymentsOnly, setPaymentsOnly] = useState(true);
  const pages = useCustomerLedger(organizationId, invoiceId, paymentsOnly);
  const items = pages.data?.pages.flatMap(p => p.entries) ?? [];
  const newest = pages.data?.pages.at(-1);
  const scroll = useRef<HTMLDivElement>(null); const edge = useScrollEdges(scroll, 'y', `${items.length}:${pages.isFetching}:${paymentsOnly}`);
  return <section aria-label={t('customerFinance.paymentsTitle')} className={s.stack}>
    {headingHidden && !withRefresh ? <h3 className={s.srOnly}>{t('customerFinance.paymentsTitle')}</h3> : (
      <div className={s.sectionHead}>
        <h3 className={headingHidden ? s.srOnly : s.heading}>{t('customerFinance.paymentsTitle')}</h3>
        {withRefresh && <Button size="small" disabled={pages.isFetching} onClick={() => void pages.refetch()}>{t('common.refresh')}</Button>}
      </div>
    )}
    <p className={s.note}>{t('customerFinance.paymentMeaning')}</p>
    {invoiceId && <p className={s.note}>{t('customerFinance.relatedMeaning')}</p>}
    <div className={s.toggleRow}>
      <Switch label={t('customerFinance.onlyPayments')} checked={paymentsOnly} onChange={(_, d) => setPaymentsOnly(d.checked)} />
      {!pages.error && !pages.isPending && !pages.isRefetching && (
        <span className={s.muted}>{newest?.oldestSnapshotAt ? t('customerFinance.snapshotAt', { date: formatDateTime(newest.oldestSnapshotAt) }) : t('customerFinance.ledgerNotImported')}</span>
      )}
    </div>
    {pages.error ? <ErrorState error={pages.error} onRetry={() => void pages.refetch()} /> :
      pages.isPending || pages.isRefetching ? <Spinner size="small" label={t('common.loading')} /> : <>
        {items.length === 0 ? <EmptyState icon={<Payment24Regular />} message={t(paymentsOnly ? 'customerFinance.paymentsEmpty' : 'customerFinance.entriesEmpty')} /> :
          <div ref={scroll} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.entriesTitle')}>
            <Table className={s.wideTable} aria-label={t('customerFinance.entriesTitle')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('customerFinance.entry')}</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{t('customerFinance.accountAmount')}</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{t('customerFinance.accountBalance')}</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{t('customerFinance.sourceAmount')}</TableHeaderCell>
                  <TableHeaderCell>{t('customerFinance.relatedInvoices')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(entry => <TableRow key={entry.id}>
                  <TableCell>
                    <span className={s.strong}>{t(`customerFinance.kind.${entry.source.kind}`)}</span>
                    <div className={s.muted}>
                      {[formatDate(entry.source.postingDate), entry.source.invoiceNo ? t('customerFinance.sourceInvoiceNo', { number: entry.source.invoiceNo }) : null].filter(Boolean).join(' · ')}
                    </div>
                    {!entry.presentInLatestScan && <p className={s.error}>{t('customerFinance.inactive', { date: formatDateTime(entry.lastSeenAt) })}</p>}
                  </TableCell>
                  <TableCell className={mergeClasses(s.number, s.strong)}>{formatNumber(entry.source.amount, 8)}</TableCell>
                  <TableCell className={s.number}>{formatNumber(entry.source.balance, 8)}</TableCell>
                  <TableCell className={s.number}>
                    {formatNumber(entry.source.currencyAmount, 8)}
                    <div className={s.muted}>{entry.source.currencyCode ?? t('customerFinance.unknownCurrency')}</div>
                  </TableCell>
                  <TableCell>
                    {entry.invoices.length > 0 ? <div className={s.actions}>{entry.invoices.map(link => <Button key={link.invoiceId} size="small" onClick={() => onInvoice(link.invoiceId)}>
                      {t('customerFinance.openRelated', { number: link.invoiceNo })}</Button>)}</div> : <span className={s.muted}>{t('customerFinance.unallocated')}</span>}
                  </TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>}
        <ListFooter shown={items.length} total={newest?.total} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </>}
  </section>;
}
