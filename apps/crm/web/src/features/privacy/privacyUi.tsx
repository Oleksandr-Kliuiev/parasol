import { Badge } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { PrivacyCaseStatus } from './api';

/** Where a request stands, as a pill: waiting on us, in progress, done or turned down. */
const statusColor: Record<PrivacyCaseStatus, 'warning' | 'informative' | 'danger' | 'success' | 'subtle'> = {
  Received: 'warning',
  Verified: 'informative',
  Previewed: 'informative',
  Executing: 'danger',
  Completed: 'success',
  Rejected: 'subtle',
};

export function CaseStatusBadge({ status }: { status: PrivacyCaseStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={statusColor[status] ?? 'subtle'}>
      {t(`privacy.statuses.${status}`)}
    </Badge>
  );
}

/** The answer is late: the statutory month has passed. */
export function OverdueBadge() {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color="danger">
      {t('privacy.cases.overdue')}
    </Badge>
  );
}
