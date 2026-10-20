import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Spinner, Tab, TabList } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { useInvoicePages } from './api';
import { billingKeys } from './api';
import { customerFinanceKey } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';
import { CustomerInvoiceDetail } from './CustomerInvoiceDetail';
import { CustomerLedgerPanel } from './CustomerLedgerPanel';
import { InvoiceStatusBadge } from './shared';

/** Mount protected queries only while both permissions are present; a customer change gets fresh local selection. */
export function CustomerFinanceTab({ organizationId }: { organizationId: string }) {
  const billing = useCan(Permissions.billingRead); const finance = useCan(Permissions.financeRead);
  if (!billing || !finance) return null;
  return <Finance key={organizationId} organizationId={organizationId} />;
}

function Finance({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const [section, setSection] = useState('invoices');
  const [selected, setSelected] = useState<string | null>(null);
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  useLayoutEffect(() => { if (selected) selectedHeading.current?.focus(); }, [selected]);
  const openInvoice = (id: string) => { setLastSelected(id); setSelected(id); setSection('invoices'); };
  return <Panel title={t('customerFinance.title')}>
    <p className={s.muted}>{t('customerFinance.subtitle')}</p>
    <TabList className={s.tabs} selectedValue={section} onTabSelect={(_, d) => { setSection(String(d.value)); setSelected(null); }} aria-label={t('customerFinance.sections')}>
      <Tab value="invoices">{t('customerFinance.invoicesTitle')}</Tab>
      <Tab value="payments">{t('customerFinance.paymentsTitle')}</Tab>
    </TabList>
    {section === 'payments' ? <CustomerLedgerPanel organizationId={organizationId} onInvoice={openInvoice} /> :
      selected ? <div className={s.stack}>
        <div className={s.actions}><Button onClick={() => setSelected(null)}>{t('customerFinance.backToList')}</Button></div>
        <h3 ref={selectedHeading} tabIndex={-1} className={s.heading}>{t('customerFinance.invoiceDetail')}</h3>
        <CustomerInvoiceDetail key={selected} organizationId={organizationId} invoiceId={selected} onInvoice={openInvoice} />
      </div> : <InvoiceList organizationId={organizationId} onInvoice={openInvoice} restoreId={lastSelected} />}
  </Panel>;
}

function InvoiceList({ organizationId, onInvoice, restoreId }: { organizationId: string; onInvoice: (id: string) => void; restoreId: string | null }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles(); const client = useQueryClient();
  const pages = useInvoicePages({ organizationId });
  const invoices = pages.data?.pages.flatMap(p => p.invoices) ?? [];
  const newest = pages.data?.pages.at(-1);
  const ref = useRef<HTMLDivElement>(null); const edge = useScrollEdges(ref, 'y', `${invoices.length}:${pages.isFetching}`);
  useLayoutEffect(() => {
    if (!pages.isFetching && restoreId) Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-finance-invoice]') ?? [])
      .find(button => button.dataset.financeInvoice === restoreId)?.focus();
  }, [pages.isFetching, restoreId]);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: customerFinanceKey(organizationId) });
    void client.invalidateQueries({ queryKey: billingKeys.invoices({ organizationId }) });
  };
  return <section aria-label={t('customerFinance.invoicesTitle')} className={s.stack}>
    <div className={s.row}><h3 className={s.heading}>{t('customerFinance.invoicesTitle')}</h3><Button disabled={pages.isFetching} onClick={refresh}>{t('common.refresh')}</Button></div>
    <p className={s.muted}>{t('customerFinance.accountCurrencyMeaning')}</p>
    {pages.error ? <ErrorState error={pages.error} onRetry={() => void pages.refetch()} /> :
      pages.isPending || pages.isRefetching ? <Spinner label={t('common.loading')} /> : <>
        {newest && newest.count > 0 && <dl className={s.facts}>
          <div><dt>{t('customerFinance.accountOutstandingTotal')}</dt><dd>{formatNumber(newest.outstanding, 8)}</dd></div>
          <div><dt>{t('customerFinance.accountOverdueTotal')}</dt><dd>{formatNumber(newest.overdue, 8)}</dd></div>
          <div><dt>{t('customerFinance.documentCount')}</dt><dd>{newest.count}</dd></div>
        </dl>}
        {invoices.length === 0 ? <p className={s.text}>{t('invoices.emptyForOrganization')}</p> :
          <div ref={ref} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.invoiceList')}>
            <ul className={s.cards}>{invoices.map(invoice => <li key={invoice.id} className={s.card}>
              <div className={s.row}><h4 className={s.heading}>{t(invoice.documentKind === 'CreditNote' ? 'customerFinance.creditNumber' : 'customerFinance.invoiceNumber', { number: invoice.invoiceNo })}</h4>
                <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} /></div>
              <dl className={s.facts}>
                <div><dt>{t('invoices.fields.dates')}</dt><dd>{formatDate(invoice.invoiceDate)}</dd></div>
                <div><dt>{t('customerFinance.accountTotal')}</dt><dd>{formatNumber(invoice.totalIncVat, 8)}</dd></div>
                <div><dt>{t('customerFinance.accountBalance')}</dt><dd>{formatNumber(invoice.outstanding, 8)}</dd></div>
              </dl>
              <Button data-finance-invoice={invoice.id} onClick={() => onInvoice(invoice.id)}>{t('customerFinance.openInvoice', { number: invoice.invoiceNo })}</Button>
            </li>)}</ul>
          </div>}
        <ListFooter shown={invoices.length} total={newest?.count} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </>}
  </section>;
}
