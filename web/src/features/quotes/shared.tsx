import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { QuoteStatus } from './types';

// Brand and tinted badges lose their contrast in the dark theme (see CLAUDE.md), so only neutral and outcome colours are used.
const colors: Record<QuoteStatus, BadgeProps['color']> = {
  Draft: 'informative',
  PendingApproval: 'warning',
  Ready: 'informative',
  Sent: 'informative',
  Accepted: 'success',
  Declined: 'danger',
  Expired: 'subtle',
  Superseded: 'subtle',
  Cancelled: 'subtle',
};

export function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="outline" color={colors[status]}>
      {t(`quotes.status.${status}`)}
    </Badge>
  );
}
