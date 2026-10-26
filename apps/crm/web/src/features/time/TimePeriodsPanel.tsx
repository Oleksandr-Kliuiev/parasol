import { Link } from 'react-router';
import { Badge, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CalendarLtr16Regular, LockClosed16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { ease } from '../../app/motion';
import { Panel } from '../../shared/components/Panel';
import { formatNumber } from '../../shared/utils/format';
import { monthName } from './monthName';
import type { Period } from './types';

const useStyles = makeStyles({
  panel: { marginTop: '16px' },
  // The months of the year as small tiles: name, hours in display type, then the state of the month.
  periods: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(168px, 100%), 1fr))',
    gap: '8px',
    '@media (max-width: 560px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  // A month opens its entries: the tile is the link, and it answers the pointer like the other cards.
  period: {
    boxSizing: 'border-box',
    display: 'grid',
    gridTemplateRows: 'auto auto 1fr',
    alignContent: 'start',
    justifyItems: 'start',
    gap: '4px',
    height: '100%',
    minWidth: 0,
    minHeight: '92px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '12px',
    backgroundColor: h.well,
    border: '1px solid transparent',
    color: h.text,
    textDecorationLine: 'none',
    transitionProperty: 'background-color, border-color, translate',
    transitionDuration: '0.2s, 0.2s, 0.4s',
    transitionTimingFunction: `ease, ease, ${ease.out}`,
    ':hover': { backgroundColor: h.surface2, borderTopColor: h.line2, borderRightColor: h.line2, borderBottomColor: h.line2, borderLeftColor: h.line2, translate: '0 -2px' },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  // The month on screen: the card colour with the ember edge; it stays recognisable in both themes.
  current: {
    backgroundColor: h.surface,
    borderTopColor: h.ember,
    borderRightColor: h.ember,
    borderBottomColor: h.ember,
    borderLeftColor: h.ember,
    boxShadow: `0 0 0 3px ${h.emberSoft}`,
    ':hover': { backgroundColor: h.surface, borderTopColor: h.ember, borderRightColor: h.ember, borderBottomColor: h.ember, borderLeftColor: h.ember },
  },
  name: { color: h.muted, fontSize: '13px', fontWeight: tokens.fontWeightSemibold, lineHeight: '18px', '&::first-letter': { textTransform: 'uppercase' } },
  currentName: { color: h.emberT },
  hours: { fontFamily: h.display, fontSize: '18px', lineHeight: '24px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  state: { alignSelf: 'end' },
});

/** The year at a glance for whoever closes the months; a month opens its own entries. */
export function TimePeriodsPanel({ periods, month, hrefFor }: { periods: Period[]; month: number; hrefFor: (month: number) => string }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  return (
    <Panel title={t('time.periods')} icon={<CalendarLtr16Regular />} className={styles.panel}>
      <ul className={styles.periods}>
        {periods.map((p) => (
          <li key={p.month}>
            <Link to={hrefFor(p.month)} replace className={mergeClasses(styles.period, p.month === month && styles.current)} aria-current={p.month === month ? 'date' : undefined}>
              <span className={mergeClasses(styles.name, p.month === month && styles.currentName)}>{monthName(p.year, p.month, i18n.language)}</span>
              <span className={styles.hours}>
                {formatNumber(p.hours)} {t('contracts.hoursShort')}
              </span>
              {p.isClosed ? (
                <Badge className={styles.state} appearance="tint" color="informative" icon={<LockClosed16Regular />}>
                  {t('time.closed')}
                </Badge>
              ) : p.newEntries > 0 ? (
                <Badge className={styles.state} appearance="tint" color="warning">
                  {t('time.pendingCount', { count: p.newEntries })}
                </Badge>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
