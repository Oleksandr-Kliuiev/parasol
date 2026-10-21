import { useRef, useState } from 'react';
import { Link, Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';
import { AppLink } from '../../shared/components/AppLink';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { FigureGrid } from '../reports/FigureGrid';
import { useInvoiceHistory } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { CustomerInvoiceDocuments } from './CustomerInvoiceDocuments';
import { CustomerLedgerPanel } from './CustomerLedgerPanel';
import { InvoiceMovements, InvoiceStatusBadge } from './shared';

export function CustomerInvoiceDetail({ organizationId, invoiceId, onInvoice, withRefresh = true }: {
  organizationId: string; invoiceId: string; onInvoice: (id: string) => void; withRefresh?: boolean;
}) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const result = useInvoiceHistory(organizationId, invoiceId);
  const [lineLimit, setLineLimit] = useState(25);
  const ref = useRef<HTMLDivElement>(null); const edge = useScrollEdges(ref, 'y', `${lineLimit}:${result.isFetching}`);
  if (result.error) return <ErrorState error={result.error} onRetry={() => void result.refetch()} />;
  if (result.isPending || result.isFetching) return <Spinner size="small" label={t('common.loading')} />;
  const { invoice, history } = result.data;
  const lines = history?.lines.slice(0, lineLimit) ?? [];
  return <div className={s.stack}>
    <div className={s.sectionHead}>
      <h4 className={s.docTitle}>{t(invoice.documentKind === 'CreditNote' ? 'customerFinance.creditNumber' : 'customerFinance.invoiceNumber', { number: invoice.invoiceNo })}</h4>
      <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
    </div>
    <div className={s.actions}>
      {invoice.url && safeHttpUrl(invoice.url) && <Link href={safeHttpUrl(invoice.url)} target="_blank" rel="noopener noreferrer">{t('customerFinance.openSource')}</Link>}
      {invoice.basisId && <AppLink to={`/billing/bases/${invoice.basisId}`}>{t('invoices.openBasis')}</AppLink>}
      <span className={s.muted}>{t('customerFinance.importedAt', { date: formatDateTime(invoice.syncedAt) })}</span>
    </div>
    {history ? <>
      <FigureGrid items={[
        { label: t('customerFinance.documentNet', { currency: history.currencyCode }), value: formatNumber(history.netAmount, 8) },
        { label: t('customerFinance.documentTotal', { currency: history.currencyCode }), value: formatNumber(history.totalAmount, 8) },
        { label: t('customerFinance.accountBalance'), value: formatNumber(history.balance, 8) },
        { label: t('customerFinance.invoiceDate'), value: formatDate(invoice.invoiceDate) },
        { label: t('customerFinance.dueDate'), value: formatDate(invoice.dueDate) || '—' },
      ]} />
      <p className={s.note}>{t('customerFinance.accountCurrencyMeaning')}</p>
      {history.isReversed && <p className={s.note}>{t('customerFinance.reversed')}</p>}
      {history.relatedInvoiceNo && <p className={s.note}>{t('customerFinance.relatedNumber', { number: history.relatedInvoiceNo })}</p>}
      <section aria-label={t('customerFinance.lines')} className={s.stack}>
        <h4 className={s.heading}>{t('customerFinance.lines')}</h4>
        <p className={s.note}>{t(`customerFinance.coverage.${history.lineCoverage}`)}</p>
        {lines.length > 0 && <div ref={ref} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.lineList')}>
          <Table className={s.table} aria-label={t('customerFinance.lineList')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('customerFinance.line')}</TableHeaderCell>
                <TableHeaderCell className={s.number}>{t('customerFinance.quantity')}</TableHeaderCell>
                <TableHeaderCell className={s.number}>{t('customerFinance.unitPrice', { currency: history.currencyCode })}</TableHeaderCell>
                <TableHeaderCell className={s.number}>{t('customerFinance.documentTotal', { currency: history.currencyCode })}</TableHeaderCell>
                <TableHeaderCell className={s.number}>{t('customerFinance.vatRate')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, index) => <TableRow key={`${line.sortOrder}-${index}`}>
                <TableCell>
                  <span className={s.strong}>{line.description || t('customerFinance.unnamedLine')}</span>
                  {line.productCode && <div className={s.muted}>{t('customerFinance.product', { code: line.productCode })}</div>}
                </TableCell>
                <TableCell className={s.number}>{[formatNumber(line.quantity, 8) || '—', line.unitCode].filter(Boolean).join(' ')}</TableCell>
                <TableCell className={s.number}>{formatNumber(line.unitPrice, 8) || '—'}</TableCell>
                <TableCell className={s.number}>{formatNumber(line.totalAmount, 8) || '—'}</TableCell>
                <TableCell className={s.number}>{line.vatRate != null ? `${formatNumber(line.vatRate * 100, 4)}%` : '—'}</TableCell>
              </TableRow>)}
            </TableBody>
          </Table>
        </div>}
        <ListFooter shown={lines.length} total={history.lines.length} hasMore={history.lines.length > lineLimit} loading={false} onMore={() => setLineLimit(n => n + 25)} />
      </section>
    </> : <>
      <p className={s.note}>{t('customerFinance.legacy')}</p>
      <InvoiceMovements movements={invoice.movements} canSeeMoney />
    </>}
    <CustomerInvoiceDocuments organizationId={organizationId} invoiceId={invoiceId} />
    <CustomerLedgerPanel key={invoiceId} organizationId={organizationId} invoiceId={invoiceId} onInvoice={onInvoice} withRefresh={withRefresh} />
  </div>;
}
