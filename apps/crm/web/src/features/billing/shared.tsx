import { Badge, type BadgeProps, Text, Tooltip, makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { formatDate, formatMoney } from '../../shared/utils/format';
import type { BasisStatus, InvoiceMovement, InvoiceStatus, RunStatus } from './types';

// A movement in two quiet lines under the amount: what the sync saw, then how much and when.
const useMovementStyles = makeStyles({
  list: { margin: 0, marginTop: '4px', padding: 0, listStyleType: 'none', display: 'grid', gap: '4px' },
  // The lines follow the cell they sit in: right under an amount, left in a record row.
  movement: { display: 'grid', color: h.muted, fontSize: '12.5px', lineHeight: '17px', textAlign: 'inherit' },
  kind: { color: h.text },
});

/**
 * What changed an invoice's remaining amount, as the sync saw it. The date is the day it was observed, not a payment date, and
 * a decrease is never called a payment: the accounting system does not say whether it was paid, credited or written off.
 */
export function InvoiceMovements({ movements, canSeeMoney }: { movements: InvoiceMovement[]; canSeeMoney: boolean }) {
  const { t } = useTranslation();
  const styles = useMovementStyles();
  if (movements.length === 0) return null;
  return (
    <ul aria-label={t('invoices.movements.label')} className={styles.list}>
      {movements.map((movement, index) => (
        <li key={`${movement.observedOn}-${movement.kind}-${index}`}>
          <Tooltip content={t('invoices.movements.dateHint')} relationship="description">
            <Text className={styles.movement} style={{ color: movement.kind === 'BalanceIncrease' ? h.saffronT : undefined }}>
              <span className={styles.kind}>{t(`invoices.movements.kinds.${movement.kind}`)}</span>
              <span>
                {canSeeMoney && movement.amount !== undefined ? `${formatMoney(movement.amount)} · ` : ''}
                {t('invoices.movements.observedOn', { date: formatDate(movement.observedOn) })}
              </span>
            </Text>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

// Status pills of the visual system: tinted with a dot, in tones whose text keeps 4.5:1 in both themes (app/hearthStyles.ts).
// "Informative" (iris) is a state on its way, "warning" (saffron) needs a look, "danger" (ember) went wrong.
const runColor: Record<RunStatus, BadgeProps['color']> = {
  Draft: 'informative',
  Collected: 'informative',
  InReview: 'warning',
  Approved: 'informative',
  Exporting: 'informative',
  Exported: 'success',
  ExportedWithErrors: 'danger',
  Closed: 'subtle',
};

const basisColor: Record<BasisStatus, BadgeProps['color']> = {
  Draft: 'informative',
  Approved: 'informative',
  Exported: 'success',
  Failed: 'danger',
  Cancelled: 'subtle',
  ReconciliationRequired: 'danger',
};

const invoiceColor: Record<InvoiceStatus, BadgeProps['color']> = {
  Draft: 'informative',
  Sent: 'informative',
  PartiallyPaid: 'warning',
  Paid: 'success',
  Overdue: 'danger',
  Credited: 'subtle',
};

export function RunStatusBadge({ status, requiresSecondApproval }: { status: RunStatus; requiresSecondApproval?: boolean }) {
  const { t } = useTranslation();
  const waiting = requiresSecondApproval && status === 'InReview';
  return (
    <Badge appearance="tint" color={runColor[status]}>
      {waiting ? t('billing.awaitingSecondApproval') : t(`billing.runStatus.${status}`)}
    </Badge>
  );
}

export function BasisStatusBadge({ status }: { status: BasisStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={basisColor[status]}>
      {t(`billing.basisStatus.${status}`)}
    </Badge>
  );
}

export function InvoiceStatusBadge({ status, isOverdue }: { status: InvoiceStatus; isOverdue?: boolean }) {
  const { t } = useTranslation();
  const effective: InvoiceStatus = isOverdue && status !== 'Paid' && status !== 'Credited' ? 'Overdue' : status;
  return (
    <Badge appearance="tint" color={invoiceColor[effective]}>
      {t(`billing.invoiceStatus.${effective}`)}
    </Badge>
  );
}
