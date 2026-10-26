import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { ease } from '../../app/motion';
import { formatMoney } from '../../shared/utils/format';
import type { RevenueMonth } from './types';

const useStyles = makeStyles({
  // The sr-only table is absolutely positioned: the wrapper holds it, so it never lengthens the page.
  wrap: { position: 'relative' },
  // Chunky columns on a quiet track, the latest month in ember (the production chart of the visual system).
  bars: { display: 'flex', alignItems: 'stretch', gap: '8px', height: '210px', '@media (max-width: 560px)': { gap: '4px', height: '170px' } },
  col: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', flex: '1 1 0', minWidth: 0, outline: 'none',
    ':focus-visible .bar-track': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    '&:hover .bar-tip, &:focus-visible .bar-tip': { opacity: 1, transform: 'translate(-50%, -4px)' } },
  track: { position: 'relative', display: 'flex', alignItems: 'flex-end', flex: '1 1 auto', borderRadius: '10px', backgroundColor: h.well, overflow: 'hidden' },
  // Bars grow from the baseline one after another when the chart appears, and glide when the period changes.
  bar: {
    width: '100%',
    minHeight: '4px',
    borderRadius: '4px 4px 0 0',
    backgroundColor: h.ink,
    opacity: 0.85,
    transformOrigin: '50% 100%',
    animationName: { from: { transform: 'scaleY(0)' } },
    animationDuration: '0.9s',
    animationTimingFunction: ease.out,
    animationFillMode: 'backwards',
    transitionProperty: 'height',
    transitionDuration: '0.7s',
    transitionTimingFunction: ease.inOut,
  },
  current: { backgroundColor: h.ember, opacity: 1 },
  label: { textAlign: 'center', color: h.muted, fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tip: {
    position: 'absolute',
    left: '50%',
    bottom: 'calc(100% - 8px)',
    zIndex: 1,
    paddingTop: '6px', paddingBottom: '6px', paddingLeft: '10px', paddingRight: '10px',
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    boxShadow: tokens.shadow16,
    fontSize: '12.5px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    opacity: 0,
    transform: 'translate(-50%, 0)',
    transitionProperty: 'opacity, transform',
    transitionDuration: '0.15s',
  },
  table: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
});

/**
 * Invoiced amount per month. Drawn with plain elements: a chart library would cost more than the picture is worth. The
 * picture is hidden from screen readers, which read the same numbers from the table; the hover/focus tip shows each value.
 */
export function RevenueChart({ months }: { months: RevenueMonth[] }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const max = Math.max(1, ...months.map((month) => month.totalExVat ?? 0));
  const monthLabel = (month: RevenueMonth) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));
  const fullLabel = (month: RevenueMonth) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));

  return (
    <div className={styles.wrap}>
      <div className={styles.bars} aria-hidden>
        {months.map((month, index) => {
          const value = month.totalExVat ?? 0;
          return (
            <div key={`${month.year}-${month.month}`} className={styles.col}>
              <span className={mergeClasses(styles.tip, 'bar-tip')}>
                {fullLabel(month)} · {formatMoney(value)}
              </span>
              <div className={mergeClasses(styles.track, 'bar-track')}>
                <span
                  className={mergeClasses(styles.bar, index === months.length - 1 && styles.current)}
                  style={{ height: `${Math.round((value / max) * 100)}%`, animationDelay: `${200 + index * 35}ms` }}
                />
              </div>
              <span className={styles.label}>{monthLabel(month)}</span>
            </div>
          );
        })}
      </div>
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
              <th scope="row">{fullLabel(month)}</th>
              <td>{formatMoney(month.totalExVat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
