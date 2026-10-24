import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { ActionStatus } from './types';

const statusColor: Record<ActionStatus, BadgeProps['color']> = {
  Scheduled: 'informative', Queued: 'informative', Sending: 'informative', Succeeded: 'success', Simulated: 'informative',
  Skipped: 'subtle', Rejected: 'warning', Failed: 'danger', Uncertain: 'warning', Cancelled: 'subtle',
};

/** The state of an action as a word with its colour; the colour never stands alone (UX 2026). */
export function ActionStatusBadge({ status }: { status: ActionStatus }) {
  const { t } = useTranslation();
  return <Badge appearance="tint" color={statusColor[status]}>{t(`actions.status.${status}`)}</Badge>;
}
