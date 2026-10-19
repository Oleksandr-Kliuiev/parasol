import { useRef, useState } from 'react';
import { Button, Spinner, Switch } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { useCustomerLedger } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';

export function CustomerLedgerPanel({ organizationId, invoiceId, onInvoice }: { organizationId: string; invoiceId?: string; onInvoice: (id: string) => void }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const [paymentsOnly, setPaymentsOnly] = useState(true);
  const pages = useCustomerLedger(organizationId, invoiceId, paymentsOnly);
  const items = pages.data?.pages.flatMap(p => p.entries) ?? [];
  const newest = pages.data?.pages.at(-1);
  const scroll = useRef<HTMLDivElement>(null); const edge = useScrollEdges(scroll, 'y', `${items.length}:${pages.isFetching}:${paymentsOnly}`);
  return <section aria-label={t('customerFinance.paymentsTitle')} className={s.stack}>
    <div className={s.row}><h3 className={s.heading}>{t('customerFinance.paymentsTitle')}</h3>
      <Button disabled={pages.isFetching} onClick={() => void pages.refetch()}>{t('common.refresh')}</Button></div>
    <p className={s.muted}>{t('customerFinance.paymentMeaning')}</p>
    {invoiceId && <p className={s.muted}>{t('customerFinance.relatedMeaning')}</p>}
    <Switch label={t('customerFinance.onlyPayments')} checked={paymentsOnly} onChange={(_, d) => setPaymentsOnly(d.checked)} />
    {pages.error ? <ErrorState error={pages.error} onRetry={() => void pages.refetch()} /> :
      pages.isPending || pages.isRefetching ? <Spinner label={t('common.loading')} /> : <>
        <p className={s.muted}>{newest?.oldestSnapshotAt ? t('customerFinance.snapshotAt', { date: formatDateTime(newest.oldestSnapshotAt) }) : t('customerFinance.ledgerNotImported')}</p>
        {items.length === 0 ? <p className={s.text}>{t(paymentsOnly ? 'customerFinance.paymentsEmpty' : 'customerFinance.entriesEmpty')}</p> :
          <div ref={scroll} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.entriesTitle')}>
            <ul className={s.cards}>{items.map(entry => <li className={s.card} key={entry.id}>
              <div className={s.row}><strong>{t(`customerFinance.kind.${entry.source.kind}`)}</strong><span>{formatDate(entry.source.postingDate)}</span></div>
              {!entry.presentInLatestScan && <p className={s.error}>{t('customerFinance.inactive', { date: formatDateTime(entry.lastSeenAt) })}</p>}
              <dl className={s.facts}>
                <div><dt>{t('customerFinance.accountAmount')}</dt><dd>{formatNumber(entry.source.amount, 8)}</dd></div>
                <div><dt>{t('customerFinance.accountBalance')}</dt><dd>{formatNumber(entry.source.balance, 8)}</dd></div>
                <div><dt>{t('customerFinance.currencyAmount', { currency: entry.source.currencyCode ?? t('customerFinance.unknownCurrency') })}</dt><dd>{formatNumber(entry.source.currencyAmount, 8)}</dd></div>
              </dl>
              {entry.source.invoiceNo && <p className={s.muted}>{t('customerFinance.sourceInvoiceNo', { number: entry.source.invoiceNo })}</p>}
              {entry.invoices.length > 0 ? <div className={s.actions}>{entry.invoices.map(link => <Button key={link.invoiceId} onClick={() => onInvoice(link.invoiceId)}>
                {t('customerFinance.openRelated', { number: link.invoiceNo })}</Button>)}</div> : <p className={s.muted}>{t('customerFinance.unallocated')}</p>}
            </li>)}</ul>
          </div>}
        <ListFooter shown={items.length} total={newest?.total} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </>}
  </section>;
}
