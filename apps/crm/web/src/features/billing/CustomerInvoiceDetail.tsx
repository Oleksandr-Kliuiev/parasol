import { useRef, useState } from 'react';
import { Link, Spinner } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';
import { AppLink } from '../../shared/components/AppLink';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { useInvoiceHistory } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';
import { CustomerInvoiceDocuments } from './CustomerInvoiceDocuments';
import { CustomerLedgerPanel } from './CustomerLedgerPanel';
import { InvoiceMovements } from './shared';

export function CustomerInvoiceDetail({ organizationId, invoiceId, onInvoice }: { organizationId: string; invoiceId: string; onInvoice: (id: string) => void }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const result = useInvoiceHistory(organizationId, invoiceId);
  const [lineLimit, setLineLimit] = useState(25);
  const ref = useRef<HTMLDivElement>(null); const edge = useScrollEdges(ref, 'y', `${lineLimit}:${result.isFetching}`);
  if (result.error) return <ErrorState error={result.error} onRetry={() => void result.refetch()} />;
  if (result.isPending || result.isFetching) return <Spinner label={t('common.loading')} />;
  const { invoice, history } = result.data;
  const lines = history?.lines.slice(0, lineLimit) ?? [];
  return <div className={s.stack}>
    <h4 className={s.heading}>{t(invoice.documentKind === 'CreditNote' ? 'customerFinance.creditNumber' : 'customerFinance.invoiceNumber', { number: invoice.invoiceNo })}</h4>
    <div className={s.actions}>
      {invoice.url && safeHttpUrl(invoice.url) && <Link href={safeHttpUrl(invoice.url)} target="_blank" rel="noopener noreferrer">{t('customerFinance.openSource')}</Link>}
      {invoice.basisId && <AppLink to={`/billing/bases/${invoice.basisId}`}>{t('invoices.openBasis')}</AppLink>}
    </div>
    <p className={s.muted}>{t('customerFinance.importedAt', { date: formatDateTime(invoice.syncedAt) })}</p>
    {history ? <>
      <dl className={s.facts}>
        <div><dt>{t('customerFinance.documentNet', { currency: history.currencyCode })}</dt><dd>{formatNumber(history.netAmount, 8)}</dd></div>
        <div><dt>{t('customerFinance.documentTotal', { currency: history.currencyCode })}</dt><dd>{formatNumber(history.totalAmount, 8)}</dd></div>
        <div><dt>{t('customerFinance.accountBalance')}</dt><dd>{formatNumber(history.balance, 8)}</dd></div>
        <div><dt>{t('invoices.fields.dates')}</dt><dd>{formatDate(invoice.invoiceDate)}</dd></div>
        <div><dt>{t('customerFinance.dueDate')}</dt><dd>{formatDate(invoice.dueDate) || '—'}</dd></div>
      </dl>
      <p className={s.muted}>{t('customerFinance.accountCurrencyMeaning')}</p>
      {history.isReversed && <p className={s.muted}>{t('customerFinance.reversed')}</p>}
      {history.relatedInvoiceNo && <p className={s.muted}>{t('customerFinance.relatedNumber', { number: history.relatedInvoiceNo })}</p>}
      <section aria-label={t('customerFinance.lines')} className={s.stack}>
        <h4 className={s.heading}>{t('customerFinance.lines')}</h4>
        <p className={s.muted}>{t(`customerFinance.coverage.${history.lineCoverage}`)}</p>
        {lines.length > 0 && <div ref={ref} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.lineList')}>
          <ul className={s.cards}>{lines.map((line, index) => <li className={s.card} key={`${line.sortOrder}-${index}`}>
            <strong>{line.description || t('customerFinance.unnamedLine')}</strong>
            {line.productCode && <p className={s.muted}>{t('customerFinance.product', { code: line.productCode })}</p>}
            <dl className={s.facts}>
              <div><dt>{t('customerFinance.quantity')}</dt><dd>{formatNumber(line.quantity, 8) || '—'} {line.unitCode}</dd></div>
              <div><dt>{t('customerFinance.unitPrice', { currency: history.currencyCode })}</dt><dd>{formatNumber(line.unitPrice, 8) || '—'}</dd></div>
              <div><dt>{t('customerFinance.documentTotal', { currency: history.currencyCode })}</dt><dd>{formatNumber(line.totalAmount, 8) || '—'}</dd></div>
              {line.vatRate != null && <div><dt>{t('customerFinance.vatRate')}</dt><dd>{formatNumber(line.vatRate * 100, 4)}%</dd></div>}
            </dl>
          </li>)}</ul>
        </div>}
        <ListFooter shown={lines.length} total={history.lines.length} hasMore={history.lines.length > lineLimit} loading={false} onMore={() => setLineLimit(n => n + 25)} />
      </section>
    </> : <>
      <p className={s.muted}>{t('customerFinance.legacy')}</p>
      <InvoiceMovements movements={invoice.movements} canSeeMoney />
    </>}
    <CustomerInvoiceDocuments organizationId={organizationId} invoiceId={invoiceId} />
    <CustomerLedgerPanel key={invoiceId} organizationId={organizationId} invoiceId={invoiceId} onInvoice={onInvoice} />
  </div>;
}
