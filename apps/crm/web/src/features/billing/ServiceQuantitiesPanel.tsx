import {
  Badge, Skeleton, SkeletonItem, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses,
} from '@fluentui/react-components';
import { CloudArrowUp16Regular, DataBarVertical16Regular, Desktop16Regular, Shield16Regular } from '@fluentui/react-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { h, type Tone } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useFlushStyles } from './flushStyles';
import { RecordRow, RowMeta } from './RecordRow';
import { useServiceQuantities, type ServiceBillLine, type ServiceQuantity, type ServiceQuantityStatus } from './serviceQuantities';

const useStyles = makeStyles({
  count: { fontSize: '18px', lineHeight: '24px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  warn: { color: h.emberT },
  bill: { display: 'grid', gap: '4px', paddingTop: '16px', borderTop: `1px solid ${h.line}` },
  billHeading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  skeleton: { display: 'grid', gap: '8px' },
});

const icons = { PerAteraDevice: <Desktop16Regular />, PerHuntressAgent: <Shield16Regular />, PerBackupSeat: <CloudArrowUp16Regular /> };

const statusLook: Record<ServiceQuantityStatus, { tone: Tone; color: 'success' | 'warning' | 'informative' | 'subtle' }> = {
  Counted: { tone: 'spruce', color: 'success' },
  NoReading: { tone: 'saffron', color: 'warning' },
  NotOnContract: { tone: 'iris', color: 'informative' },
  None: { tone: 'neutral', color: 'subtle' },
};

/** When and how the count was read, in the reader's words. */
function readingText(t: TFunction, service: ServiceQuantity) {
  if (service.count === null) return t('billing.serviceQuantities.notRead');
  if (service.readOn) return t('billing.serviceQuantities.readOn', { date: formatDate(service.readOn) });
  return t('billing.serviceQuantities.live');
}

/**
 * "Money" of M43 on the customer's contracts tab: what Atera, Huntress and CloudAlly count for the customer, against the contract
 * lines in force that bill them — the quantity the next billing basis takes for each line — and the bill lines CloudAlly charged the
 * partner (their amounts only for readers of purchase prices). A count older than the billing's limit is said in words, not only in
 * colour; a service no line bills is named, without claiming it is unbilled (it may be part of a fixed price).
 */
export function ServiceQuantitiesPanel({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const flush = useFlushStyles();
  const read = useServiceQuantities(organizationId);
  const services = read.data?.services ?? [];
  const bills = services.find((s) => s.model === 'PerBackupSeat')?.billLines ?? [];

  return (
    <Panel flush className={flush.panel} title={t('billing.serviceQuantities.title')} icon={<DataBarVertical16Regular />}>
      <Text block className={mergeClasses(flush.body, flush.muted)}>{t('billing.serviceQuantities.intro')}</Text>
      {read.error ? (
        <div className={flush.body}><ErrorState error={read.error} onRetry={() => void read.refetch()} /></div>
      ) : read.isPending ? (
        <Skeleton aria-label={t('common.loading')} className={mergeClasses(flush.body, styles.skeleton)}><SkeletonItem /><SkeletonItem /><SkeletonItem /></Skeleton>
      ) : (
        <ul className={flush.list}>
          {services.map((service) => (
            <ServiceRow key={service.model} service={service} staleDays={read.data?.staleQuantityDays ?? 0} />
          ))}
        </ul>
      )}
      {bills.length > 0 && <BillLines lines={bills} />}
    </Panel>
  );
}

function ServiceRow({ service, staleDays }: { service: ServiceQuantity; staleDays: number }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const look = statusLook[service.status];
  const detail = service.detail ? Object.entries(service.detail) : [];
  return (
    <RecordRow
      icon={icons[service.model]}
      tone={look.tone}
      title={t(`billing.serviceQuantities.sources.${service.model}`)}
      meta={<>
        <RowMeta>
          {readingText(t, service)}
          {service.stale && <span className={styles.warn}>{' · '}{t('billing.serviceQuantities.stale', { count: staleDays })}</span>}
        </RowMeta>
        {detail.length > 0 && (
          <RowMeta>{detail.map(([type, count]) => `${t(`service.deviceTypes.${type}`, { defaultValue: type })} ${formatNumber(count, 0)}`).join(' · ')}</RowMeta>
        )}
        {service.lines.map((line) => (
          <RowMeta key={line.lineId}>
            {t('billing.serviceQuantities.line', {
              product: line.productName, contract: line.contractNumber, estimate: formatNumber(line.estimate, 0), billed: formatNumber(line.billed, 0),
            })}
          </RowMeta>
        ))}
        {service.status === 'NotOnContract' && <RowMeta>{t('billing.serviceQuantities.notOnContract')}</RowMeta>}
      </>}
      end={<>
        <span className={styles.count}>{service.count === null ? '—' : formatNumber(service.count, 0)}</span>
        <Badge appearance="tint" color={look.color}>{t(`billing.serviceQuantities.status.${service.status}`)}</Badge>
      </>}
    />
  );
}

/** What CloudAlly bills the partner for the customer's accounts, as its nightly bill read stored it. */
function BillLines({ lines }: { lines: ServiceBillLine[] }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const flush = useFlushStyles();
  const canSeeCost = useCan(Permissions.financeCostRead);
  const title = t('billing.serviceQuantities.bill.title');
  return (
    <div className={styles.bill}>
      <div className={flush.body}>
        <h3 className={styles.billHeading}>{title}</h3>
        <Text block className={flush.muted}>
          {t('billing.serviceQuantities.bill.day', { date: formatDate(lines[0]!.day) })}
          {!canSeeCost && ` ${t('billing.serviceQuantities.bill.noMoney')}`}
        </Text>
      </div>
      <ScrollTable className={flush.scroll} label={title}>
        <Table aria-label={title} size="small" className={flush.table}>
          <TableHeader><TableRow>
            <TableHeaderCell>{t('billing.serviceQuantities.bill.account')}</TableHeaderCell>
            <TableHeaderCell>{t('billing.serviceQuantities.bill.service')}</TableHeaderCell>
            <TableHeaderCell className={styles.number}>{t('billing.serviceQuantities.bill.seats')}</TableHeaderCell>
            {canSeeCost && <TableHeaderCell className={styles.number}>{t('billing.serviceQuantities.bill.price')}</TableHeaderCell>}
            {canSeeCost && <TableHeaderCell className={styles.number}>{t('billing.serviceQuantities.bill.total')}</TableHeaderCell>}
          </TableRow></TableHeader>
          <TableBody>{lines.map((line, index) => (
            <TableRow key={`${line.account}-${line.source}-${line.service ?? ''}-${index}`}>
              <TableCell>{line.accountName ?? line.account}</TableCell>
              <TableCell>{line.service ?? line.source}</TableCell>
              <TableCell className={styles.number}>{line.seats ?? line.accounts ?? '—'}</TableCell>
              {canSeeCost && <TableCell className={styles.number}>{line.price == null ? '—' : formatMoney(line.price, line.currency ?? undefined)}</TableCell>}
              {canSeeCost && <TableCell className={styles.number}>{line.total == null ? '—' : formatMoney(line.total, line.currency ?? undefined)}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      </ScrollTable>
    </div>
  );
}
