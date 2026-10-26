import { Badge } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../shared/utils/format';
import { contractStatusColor, type ContractStatus } from './types';
import { h } from '../../app/hearth';

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={contractStatusColor[status]}>
      {t(`contracts.statuses.${status}`)}
    </Badge>
  );
}

/** Remaining hours as a bar; turns saffron below the low-balance threshold (BR-CON-05). `wide` fills its container. */
export function HoursMeter({ remaining, purchased, isLow, wide }: { remaining: number; purchased: number; isLow: boolean; wide?: boolean }) {
  const { t } = useTranslation();
  const pct = purchased > 0 ? Math.max(0, Math.min(100, (remaining / purchased) * 100)) : 0;
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={purchased}
      aria-valuenow={remaining}
      aria-label={t('contracts.hourBanks.remainingOf', { remaining: formatNumber(remaining), purchased: formatNumber(purchased) })}
      style={{ display: 'inline-block', width: wide ? '100%' : 96, height: 8, borderRadius: 999, background: h.well, overflow: 'hidden', verticalAlign: 'middle' }}
    >
      <span style={{ display: 'block', height: '100%', borderRadius: 999, width: `${pct}%`, background: isLow ? h.saffron : h.spruce }} />
    </span>
  );
}
