import { useId } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatMoney, formatNumber } from '../../shared/utils/format';
import type { RevenueMonth } from './types';

const useStyles = makeStyles({
  wrap: { overflowX: 'auto' },
  chart: { display: 'block', minWidth: '320px', width: '100%', height: 'auto' },
  bar: { fill: tokens.colorBrandBackground },
  axis: { stroke: tokens.colorNeutralStroke2 },
  label: { fill: tokens.colorNeutralForeground3, fontSize: '10px' },
  value: { fill: tokens.colorNeutralForeground1, fontSize: '10px', fontWeight: tokens.fontWeightSemibold },
  table: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
});

/**
 * Invoiced amount per month. Drawn by hand: a chart library would cost more than the picture is worth, and the same numbers
 * are also in a table for screen readers.
 */
export function RevenueChart({ months }: { months: RevenueMonth[] }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const width = 640;
  const height = 200;
  const padding = { top: 16, right: 8, bottom: 28, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...months.map((month) => month.totalExVat ?? 0));
  const slot = months.length > 0 ? plotWidth / months.length : plotWidth;
  const barWidth = Math.max(8, Math.min(56, slot * 0.6));
  const monthLabel = (month: RevenueMonth) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));

  return (
    <div className={styles.wrap}>
      <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{t('dashboard.revenueChartTitle')}</title>
        <line className={styles.axis} x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} />
        {months.map((month, index) => {
          const value = month.totalExVat ?? 0;
          const barHeight = max === 0 ? 0 : (value / max) * plotHeight;
          const x = padding.left + (index * slot) + ((slot - barWidth) / 2);
          const y = height - padding.bottom - barHeight;
          return (
            <g key={`${month.year}-${month.month}`}>
              <rect className={styles.bar} x={x} y={y} width={barWidth} height={Math.max(barHeight, value > 0 ? 2 : 0)} rx={2} />
              {value > 0 && (
                <text className={styles.value} x={x + (barWidth / 2)} y={Math.max(y - 4, 10)} textAnchor="middle">
                  {formatNumber(value, 0)}
                </text>
              )}
              <text className={styles.label} x={x + (barWidth / 2)} y={height - padding.bottom + 14} textAnchor="middle">
                {monthLabel(month)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className={styles.table}>
        <caption>{t('dashboard.revenueChartTitle')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.fields.month')}</th>
            <th scope="col">{t('dashboard.fields.revenue')}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr key={`${month.year}-${month.month}`}>
              <th scope="row">{monthLabel(month)}</th>
              <td>{formatMoney(month.totalExVat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
