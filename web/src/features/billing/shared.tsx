import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { BasisStatus, InvoiceStatus, RunStatus } from './types';

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
