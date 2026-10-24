import type { ReactNode } from 'react';
import { Badge, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Clock12Regular, Key16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { useFlushStyles } from '../billing/flushStyles';
import { useCatalogStyles } from '../catalog/styles';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import type { Subscription } from './types';

const useStyles = makeStyles({
  // The open cancellation window under the renewal date: a warning line with a clock that wraps in its column (a pill
  // would keep to one line and run into the price next to it).
  window: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '4px',
    marginTop: '4px',
    color: h.saffronT,
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    '& svg': { flexShrink: 0, marginTop: '2px' },
  },
  unlinked: { color: h.muted, fontWeight: 600 },
});

interface SubscriptionTableProps {
  rows: Subscription[];
  /** The customer column of the list across customers; a customer's own tab leaves it out. */
  showCustomer: boolean;
  canSeeCost: boolean;
  /** Shown in the card under the headers when there are no rows. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** The table sits in a Panel, which is already the card. */
  inPanel?: boolean;
}

/** CSP subscriptions with the two things that cost money if missed: the cancellation window and the renewal (BR-LIC-02/03). */
export function SubscriptionTable({ rows, showCustomer, canSeeCost, empty, footer, inPanel }: SubscriptionTableProps) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();

  return (
    <ScrollTable className={mergeClasses(catalog.tableWrap, inPanel && record.flatTable)}>
      <Table className={mergeClasses(catalog.table, flush.cells)} style={{ minWidth: showCustomer ? 1080 : 920 }} aria-label={t('licenses.title')}>
        <TableHeader>
          <TableRow>
            {/* Content widths: every cell adds 12 px of padding on each side; offer and customer share the rest. */}
            <TableHeaderCell>{t('licenses.fields.offer')}</TableHeaderCell>
            {showCustomer && <TableHeaderCell>{t('licenses.fields.customer')}</TableHeaderCell>}
            <TableHeaderCell className={catalog.number} style={{ width: 56 }}>{t('licenses.fields.quantity')}</TableHeaderCell>
            <TableHeaderCell style={{ width: 116 }}>{t('licenses.fields.term')}</TableHeaderCell>
            <TableHeaderCell style={{ width: 150 }}>{t('licenses.fields.renewal')}</TableHeaderCell>
            {canSeeCost && <TableHeaderCell className={catalog.number} style={{ width: 90 }}>{t('licenses.fields.partnerPrice')}</TableHeaderCell>}
            <TableHeaderCell style={{ width: 128 }}>{t('licenses.fields.billing')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((subscription) => (
            <TableRow key={subscription.id}>
              <TableCell>
                <RecordCell
                  icon={<Key16Regular />}
                  tone="iris"
                  name={<span className={catalog.name}>{subscription.offerName ?? subscription.offerId}</span>}
                  meta={
                    showCustomer
                      ? [<span className={catalog.sku}>{subscription.offerId}</span>, subscription.source === 'Distributor' && t('licenses.sources.Distributor')]
                      : [
                          subscription.productName && subscription.productName !== subscription.offerName
                            ? subscription.productName
                            : <span className={catalog.sku}>{subscription.offerId}</span>,
                        ]
                  }
                />
              </TableCell>
              {showCustomer && (
                <TableCell>
                  {subscription.organizationId ? (
                    <RecordCell
                      avatarName={subscription.organizationName ?? ''}
                      size={28}
                      name={<AppLink to={`/organizations/${subscription.organizationId}?tab=licenses`} className={record.quietLink}>{subscription.organizationName}</AppLink>}
                    />
                  ) : (
                    <RecordCell
                      avatarName={subscription.cspCustomerName ?? ''}
                      size={28}
                      name={<span className={styles.unlinked}>{subscription.cspCustomerName}</span>}
                      meta={[t('licenses.notLinked')]}
                    />
                  )}
                </TableCell>
              )}
              <TableCell className={catalog.number}>{formatNumber(subscription.quantity, 0)}</TableCell>
              <TableCell>
                {subscription.term === 'Unknown' ? '—' : t(`licenses.terms.${subscription.term}`)}
                <div className={catalog.muted}>{subscription.autoRenew ? t('licenses.autoRenews') : t('licenses.noAutoRenew')}</div>
              </TableCell>
              <TableCell className="tabular">
                {subscription.renewalDate
                  ? formatDate(subscription.renewalDate)
                  : subscription.commitmentEndDate
                    ? formatDate(subscription.commitmentEndDate)
                    : '—'}
                {subscription.cancellationWindowOpen && subscription.cancellationWindowEndsAt && (
                  <div className={styles.window}>
                    <Clock12Regular aria-hidden />
                    <span>{t('licenses.windowUntil', { at: formatDateTime(subscription.cancellationWindowEndsAt) })}</span>
                  </div>
                )}
              </TableCell>
              {canSeeCost && <TableCell className={catalog.number}>{formatMoney(subscription.partnerUnitPrice)}</TableCell>}
              <TableCell>
                {subscription.isBilled ? (
                  <Badge appearance="tint" color="success">
                    {t('licenses.billed')}
                  </Badge>
                ) : (
                  <Badge appearance="tint" color="warning">
                    {subscription.productId ? t('licenses.noContractLine') : t('licenses.noProduct')}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 && empty}
      {footer}
    </ScrollTable>
  );
}
