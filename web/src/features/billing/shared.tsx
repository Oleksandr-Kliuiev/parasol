import { Badge, type BadgeProps, Text, Tooltip, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatDate, formatMoney } from '../../shared/utils/format';
import type { BasisStatus, InvoiceMovement, InvoiceStatus, RunStatus } from './types';

/**
 * What changed an invoice's remaining amount, as the sync saw it. The date is the day it was observed, not a payment date, and
 * a decrease is never called a payment: the accounting system does not say whether it was paid, credited or written off.
 */
export function InvoiceMovements({ movements, canSeeMoney }: { movements: InvoiceMovement[]; canSeeMoney: boolean }) {
  const { t } = useTranslation();
  if (movements.length === 0) return null;
  return (
    <ul aria-label={t('invoices.movements.label')} style={{ margin: 0, paddingLeft: tokens.spacingHorizontalM, listStyle: 'none' }}>
      {movements.map((movement, index) => (
        <li key={`${movement.observedOn}-${movement.kind}-${index}`}>
          <Tooltip content={t('invoices.movements.dateHint')} relationship="description">
            <Text size={200} style={{ color: movement.kind === 'BalanceIncrease' ? tokens.colorPaletteDarkOrangeForeground1 : tokens.colorNeutralForeground3 }}>
              {t(`invoices.movements.kinds.${movement.kind}`)}
              {canSeeMoney && movement.amount !== undefined ? ` ${formatMoney(movement.amount)}` : ''}
              {' · '}
              {t('invoices.movements.observedOn', { date: formatDate(movement.observedOn) })}
            </Text>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

// Brand and tinted badges lose their contrast in the dark theme (see CLAUDE.md), so only neutral and outcome colours are used.
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
    <Badge appearance="outline" color={runColor[status]}>
      {waiting ? t('billing.awaitingSecondApproval') : t(`billing.runStatus.${status}`)}
    </Badge>
  );
}

export function BasisStatusBadge({ status }: { status: BasisStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="outline" color={basisColor[status]}>
      {t(`billing.basisStatus.${status}`)}
    </Badge>
  );
}

export function InvoiceStatusBadge({ status, isOverdue }: { status: InvoiceStatus; isOverdue?: boolean }) {
  const { t } = useTranslation();
  const effective: InvoiceStatus = isOverdue && status !== 'Paid' && status !== 'Credited' ? 'Overdue' : status;
  return (
    <Badge appearance="outline" color={invoiceColor[effective]}>
      {t(`billing.invoiceStatus.${effective}`)}
    </Badge>
  );
}
