import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Spinner, Tab, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, mergeClasses } from '@fluentui/react-components';
import { ArrowLeft20Regular, Receipt24Regular, Wallet16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { ScrollTabList } from '../../shared/components/ScrollTabList';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { FigureGrid } from '../reports/FigureGrid';
import { useInvoicePages } from './api';
import { billingKeys } from './api';
import { customerFinanceKey } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
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
  const { t } = useTranslation(); const s = useCustomerFinanceStyles(); const client = useQueryClient();
  const [section, setSection] = useState('invoices');
  // One Refresh for the card: it rereads the saved copies of whatever section is on screen.
  const fetching = useIsFetching({ queryKey: customerFinanceKey(organizationId) }) + useIsFetching({ queryKey: billingKeys.invoices({ organizationId }) });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: customerFinanceKey(organizationId) });
    void client.invalidateQueries({ queryKey: billingKeys.invoices({ organizationId }) });
  };
  const [selected, setSelected] = useState<string | null>(null);
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  useLayoutEffect(() => { if (selected) selectedHeading.current?.focus(); }, [selected]);
  const openInvoice = (id: string) => { setLastSelected(id); setSelected(id); setSection('invoices'); };
  return <Panel title={t('customerFinance.title')} icon={<Wallet16Regular />}
    actions={<Button size="small" disabled={fetching > 0} onClick={refresh}>{t('common.refresh')}</Button>}>
    <p className={s.note}>{t('customerFinance.subtitle')}</p>
    <ScrollTabList className={s.tabs} selectedValue={section} onTabSelect={(_, d) => { setSection(String(d.value)); setSelected(null); }} aria-label={t('customerFinance.sections')}>
      <Tab value="invoices">{t('customerFinance.invoicesTitle')}</Tab>
      <Tab value="payments">{t('customerFinance.paymentsTitle')}</Tab>
    </ScrollTabList>
    {section === 'payments' ? <CustomerLedgerPanel organizationId={organizationId} onInvoice={openInvoice} headingHidden withRefresh={false} /> :
      selected ? <div className={s.stack}>
        <div className={s.actions}><Button icon={<ArrowLeft20Regular />} onClick={() => setSelected(null)}>{t('customerFinance.backToList')}</Button></div>
        <h3 ref={selectedHeading} tabIndex={-1} className={s.eyebrow}>{t('customerFinance.invoiceDetail')}</h3>
        <CustomerInvoiceDetail key={selected} organizationId={organizationId} invoiceId={selected} onInvoice={openInvoice} withRefresh={false} />
      </div> : <InvoiceList organizationId={organizationId} onInvoice={openInvoice} restoreId={lastSelected} />}
  </Panel>;
}

function InvoiceList({ organizationId, onInvoice, restoreId }: { organizationId: string; onInvoice: (id: string) => void; restoreId: string | null }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const pages = useInvoicePages({ organizationId });
  const invoices = pages.data?.pages.flatMap(p => p.invoices) ?? [];
  const newest = pages.data?.pages.at(-1);
  const narrow = useMediaQuery(NARROW_SCREEN);
  const ref = useRef<HTMLDivElement>(null); const edge = useScrollEdges(ref, 'y', `${invoices.length}:${pages.isFetching}`);
  useLayoutEffect(() => {
    if (!pages.isFetching && restoreId) Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-finance-invoice]') ?? [])
      .find(button => button.dataset.financeInvoice === restoreId)?.focus();
  }, [pages.isFetching, restoreId]);
  return <section aria-label={t('customerFinance.invoicesTitle')} className={s.stack}>
    <h3 className={s.srOnly}>{t('customerFinance.invoicesTitle')}</h3>
    {pages.error ? <ErrorState error={pages.error} onRetry={() => void pages.refetch()} /> :
      pages.isPending || pages.isRefetching ? <Spinner size="small" label={t('common.loading')} /> : <>
        {newest && newest.count > 0 && <>
          <FigureGrid items={[
            { label: t('customerFinance.accountOutstandingTotal'), value: formatNumber(newest.outstanding, 8) },
            { label: t('customerFinance.accountOverdueTotal'), value: formatNumber(newest.overdue, 8) },
            { label: t('customerFinance.documentCount'), value: String(newest.count) },
          ]} />
          <p className={s.note}>{t('customerFinance.accountCurrencyMeaning')}</p>
        </>}
        {invoices.length === 0 ? <EmptyState icon={<Receipt24Regular />} message={t('invoices.emptyForOrganization')} /> : narrow ?
          <div ref={ref} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.invoiceList')}>
            <ul className={s.rows}>{invoices.map(invoice => <li key={invoice.id} className={s.row}>
              <span className={s.rowMain}>
                <span className={s.strong}>{t(invoice.documentKind === 'CreditNote' ? 'customerFinance.creditNumber' : 'customerFinance.invoiceNumber', { number: invoice.invoiceNo })}</span>
                <span className={s.muted}>{formatDate(invoice.invoiceDate)}</span>
                <span className={s.muted}>
                  {t('customerFinance.totalShort')} {formatNumber(invoice.totalIncVat, 8)} · {t('customerFinance.balanceShort')} {formatNumber(invoice.outstanding, 8)}
                </span>
              </span>
              <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
              <span>
                <Button size="small" data-finance-invoice={invoice.id} onClick={() => onInvoice(invoice.id)}>{t('customerFinance.openInvoice', { number: invoice.invoiceNo })}</Button>
              </span>
            </li>)}</ul>
          </div> :
          <div ref={ref} className={s.scroll} style={edge.style} tabIndex={0} role="region" aria-label={t('customerFinance.invoiceList')}>
            <Table className={s.wideTable} aria-label={t('customerFinance.invoiceList')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('customerFinance.document')}</TableHeaderCell>
                  <TableHeaderCell>{t('customerFinance.invoiceDate')}</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{t('customerFinance.accountTotal')}</TableHeaderCell>
                  <TableHeaderCell className={s.number}>{t('customerFinance.accountBalance')}</TableHeaderCell>
                  <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                  <TableHeaderCell className={s.actionColumn} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map(invoice => <TableRow key={invoice.id}>
                  <TableCell>
                    <span className={s.strong}>{t(invoice.documentKind === 'CreditNote' ? 'customerFinance.creditNumber' : 'customerFinance.invoiceNumber', { number: invoice.invoiceNo })}</span>
                  </TableCell>
                  <TableCell className="tabular">{formatDate(invoice.invoiceDate)}</TableCell>
                  <TableCell className={s.number}>{formatNumber(invoice.totalIncVat, 8)}</TableCell>
                  <TableCell className={mergeClasses(s.number, s.strong)}>{formatNumber(invoice.outstanding, 8)}</TableCell>
                  <TableCell><InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} /></TableCell>
                  <TableCell>
                    <Button size="small" data-finance-invoice={invoice.id} onClick={() => onInvoice(invoice.id)}>{t('customerFinance.openInvoice', { number: invoice.invoiceNo })}</Button>
                  </TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>}
        <ListFooter shown={invoices.length} total={newest?.count} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </>}
  </section>;
}
