import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { QuoteStatus } from './types';

// Status pills of the visual system: the global badge style gives each tint a dot and a text step with 4.5:1 in both themes.
const colors: Record<QuoteStatus, BadgeProps['color']> = {
  Draft: 'subtle',
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
    <Badge appearance="tint" color={colors[status]}>
      {t(`quotes.status.${status}`)}
    </Badge>
  );
}
