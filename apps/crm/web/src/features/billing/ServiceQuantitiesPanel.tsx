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
  // The table lays its columns out fixed: the figures get narrow columns of their own (border-box, so a header's padding does not
  // widen them), the names share the rest, and a narrow phone scrolls the table sideways rather than squeezing a name into letters.
  billTable: { minWidth: '340px', '& th': { boxSizing: 'border-box' }, '& td': { overflowWrap: 'break-word' } },
  number: {
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
  // Narrow enough to leave a phone's name column room for "SharePoint" in one piece, wide enough for a four-figure total.
  seatsColumn: { width: '64px' },
  moneyColumn: { width: '88px' },
  skeleton: { display: 'grid', gap: '8px' },
});

const icons = { PerAteraDevice: <Desktop16Regular />, PerHuntressAgent: <Shield16Regular />, PerBackupSeat: <CloudArrowUp16Regular /> };

/** A count of 0 and an old count are billed as they are, but neither is green: the first bills nothing, the second may be wrong. */
type Look = ServiceQuantityStatus | 'CountedZero' | 'CountedStale';

const statusLook: Record<Look, { tone: Tone; color: 'success' | 'warning' | 'informative' | 'subtle' }> = {
  Counted: { tone: 'spruce', color: 'success' },
  CountedZero: { tone: 'saffron', color: 'warning' },
  CountedStale: { tone: 'saffron', color: 'warning' },
  NoReading: { tone: 'saffron', color: 'warning' },
  NotOnContract: { tone: 'iris', color: 'informative' },
  None: { tone: 'neutral', color: 'subtle' },
};

const lookOf = (service: ServiceQuantity): Look =>
  service.status !== 'Counted' ? service.status : service.count === 0 ? 'CountedZero' : service.stale ? 'CountedStale' : 'Counted';

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
  const backup = services.find((s) => s.model === 'PerBackupSeat');
  const bills = backup?.billLines ?? [];

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
      {bills.length > 0 && <BillLines lines={bills} counted={backup?.count ?? null} />}
    </Panel>
  );
}

function ServiceRow({ service, staleDays }: { service: ServiceQuantity; staleDays: number }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const status = lookOf(service);
  const look = statusLook[status];
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
        <Badge appearance="tint" color={look.color}>{t(`billing.serviceQuantities.status.${status}`)}</Badge>
      </>}
    />
  );
}

/** What CloudAlly bills the partner for the customer's accounts, as its nightly bill read stored it. */
function BillLines({ lines, counted }: { lines: ServiceBillLine[]; counted: number | null }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const flush = useFlushStyles();
  const canSeeCost = useCan(Permissions.financeCostRead);
  const title = t('billing.serviceQuantities.bill.title');
  // Most customers have one account: it is named once above the table instead of in every row.
  const accounts = [...new Set(lines.map((line) => line.accountName ?? line.account))];
  const day = formatDate(lines[0]!.day);
  return (
    <div className={styles.bill}>
      <div className={flush.body}>
        <h3 className={styles.billHeading}>{title}</h3>
        <Text block className={flush.muted}>
          {accounts.length === 1
            ? t('billing.serviceQuantities.bill.dayAccount', { date: day, account: accounts[0] })
            : t('billing.serviceQuantities.bill.day', { date: day })}
          {!canSeeCost && ` ${t('billing.serviceQuantities.bill.noMoney')}`}
        </Text>
      </div>
      <ScrollTable className={flush.scroll} label={title}>
        <Table aria-label={title} size="small" className={mergeClasses(flush.table, styles.billTable)}>
          <TableHeader><TableRow>
            {accounts.length > 1 && <TableHeaderCell>{t('billing.serviceQuantities.bill.account')}</TableHeaderCell>}
            <TableHeaderCell>{t('billing.serviceQuantities.bill.service')}</TableHeaderCell>
            <TableHeaderCell className={mergeClasses(styles.number, styles.seatsColumn)}>{t('billing.serviceQuantities.bill.seats')}</TableHeaderCell>
            {canSeeCost && <TableHeaderCell className={mergeClasses(styles.number, styles.moneyColumn)}>{t('billing.serviceQuantities.bill.price')}</TableHeaderCell>}
            {canSeeCost && <TableHeaderCell className={mergeClasses(styles.number, styles.moneyColumn)}>{t('billing.serviceQuantities.bill.total')}</TableHeaderCell>}
          </TableRow></TableHeader>
          <TableBody>{lines.map((line, index) => (
            <TableRow key={`${line.account}-${line.source}-${line.service ?? ''}-${index}`}>
              {accounts.length > 1 && <TableCell>{line.accountName ?? line.account}</TableCell>}
              <TableCell>{line.service ?? line.source}</TableCell>
              <TableCell className={styles.number}>{line.users ?? '—'}</TableCell>
              {canSeeCost && <TableCell className={styles.number}>{line.price == null ? '—' : formatMoney(line.price, line.currency ?? undefined)}</TableCell>}
              {canSeeCost && <TableCell className={styles.number}>{line.total == null ? '—' : formatMoney(line.total, line.currency ?? undefined)}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      </ScrollTable>
      {/* The count above is not the sum of these rows: say the rule, so the two can be matched. */}
      {counted !== null && <Text block className={mergeClasses(flush.body, flush.muted)}>{t('billing.serviceQuantities.bill.rule', { count: counted })}</Text>}
    </div>
  );
}
