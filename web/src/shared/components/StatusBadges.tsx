import { Badge, Tooltip, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { OrganizationStatus, RegistryStatus } from '../../api/types';
import { formatDate } from '../utils/format';

const statusColor: Record<OrganizationStatus, BadgeProps['color']> = {
  Lead: 'informative',
  Prospect: 'brand',
  Customer: 'success',
  Former: 'subtle',
  Partner: 'important',
};

export function OrganizationStatusBadge({ status }: { status: OrganizationStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" shape="rounded" color={statusColor[status]}>
      {t(`status.${status}`)}
    </Badge>
  );
}

const registryColor: Record<RegistryStatus, BadgeProps['color'] | null> = {
  Unknown: null,
  Active: null,
  UnderDissolution: 'warning',
  Bankrupt: 'danger',
  Deleted: 'danger',
  NotFound: 'warning',
};

/** Shows only statuses that need attention unless `showActive` is set. */
export function RegistryStatusBadge({
  status,
  checkedAt,
  showActive = false,
}: {
  status: RegistryStatus;
  checkedAt?: string | null;
  showActive?: boolean;
}) {
  const { t } = useTranslation();
  const color = registryColor[status];
  if (!color && !showActive) return null;
  const badge = (
    <Badge appearance={color ? 'filled' : 'outline'} shape="rounded" color={color ?? 'subtle'}>
      {t(`registry.${status}`)}
    </Badge>
  );
  return checkedAt ? (
    <Tooltip content={t('registry.checkedAt', { date: formatDate(checkedAt) })} relationship="description">
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}
