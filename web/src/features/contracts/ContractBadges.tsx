import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../shared/utils/format';
import type { ContractStatus } from './types';

const statusColor: Record<ContractStatus, BadgeProps['color']> = {
  Draft: 'informative',
  Active: 'success',
  Suspended: 'warning',
  NoticeGiven: 'important',
  Ended: 'subtle',
};

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance={status === 'Draft' ? 'outline' : 'tint'} shape="rounded" color={statusColor[status]}>
      {t(`contracts.statuses.${status}`)}
    </Badge>
  );
}

/** Remaining hours as a bar; turns orange below the low-balance threshold (BR-CON-05). */
export function HoursMeter({ remaining, purchased, isLow }: { remaining: number; purchased: number; isLow: boolean }) {
  const { t } = useTranslation();
  const pct = purchased > 0 ? Math.max(0, Math.min(100, (remaining / purchased) * 100)) : 0;
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={purchased}
      aria-valuenow={remaining}
      aria-label={t('contracts.hourBanks.remainingOf', { remaining: formatNumber(remaining), purchased: formatNumber(purchased) })}
      style={{ display: 'inline-block', width: 96, height: 6, borderRadius: 3, background: 'var(--colorNeutralBackground5)', overflow: 'hidden', verticalAlign: 'middle' }}
    >
      <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: isLow ? 'var(--colorPaletteDarkOrangeBackground3)' : 'var(--colorPaletteGreenBackground3)' }} />
    </span>
  );
}
