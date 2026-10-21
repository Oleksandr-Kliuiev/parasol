import { Link } from 'react-router';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from './shellIcons';
import { useTranslation } from 'react-i18next';
import { h } from './hearth';
import { useNavGroups } from './navigation';

/**
 * Phone tabs (UX concept §4): the three places used all day, the rest sits behind "More" (the full menu). A tab has a
 * short label of its own (`nav.tabLabels`) so that it fits a 320 px screen without ellipsis.
 */
const TAB_VALUES = ['my-day', 'organizations', 'timesheet'] as const;
export const TAB_BAR_HEIGHT = '64px';
/** Room the page keeps free below its content: the floating bar, its 10 px offset and a margin. */
export const TAB_BAR_SPACE = '96px';

const useStyles = makeStyles({
  // A floating dark bar, inset from the screen edges, as in the reference; it shares the rail's colours.
  bar: {
    position: 'fixed',
    left: '10px',
    // Keeps its width while a modal's scroll lock widens the window by the scrollbar it hides (scrollLock.ts).
    right: 'calc(10px + var(--h-locked-scrollbar, 0px))',
    bottom: 'calc(10px + env(safe-area-inset-bottom))',
    zIndex: 15,
    display: 'grid',
    gridAutoColumns: 'minmax(0, 1fr)',
    gridAutoFlow: 'column',
    gap: '4px',
    boxSizing: 'border-box',
    height: TAB_BAR_HEIGHT,
    padding: '6px',
    borderRadius: '22px',
    backgroundColor: 'color-mix(in srgb, var(--h-side-bg) 94%, transparent)',
    backdropFilter: 'blur(16px) saturate(1.3)',
    color: h.sideMuted,
    boxShadow: '0 18px 40px -16px rgba(20, 14, 10, 0.55), inset 0 1px rgba(255, 255, 255, 0.06)',
  },
  tab: {
    position: 'relative',
    minWidth: 0,
    display: 'grid',
    alignContent: 'center',
    justifyItems: 'center',
    gap: '3px',
    paddingInline: '4px',
    border: 'none',
    borderRadius: '16px',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 700,
    lineHeight: '16px',
    textDecorationLine: 'none',
    cursor: 'pointer',
    ':focus-visible': { outline: `2px solid ${h.sideText}`, outlineOffset: '-2px' },
  },
  current: {
    color: h.sideText,
    backgroundColor: h.sidePill,
    boxShadow: 'inset 0 1px rgba(255, 255, 255, 0.06)',
    '& svg': { color: '#FF8A62' },
    '::after': {
      content: '""',
      position: 'absolute',
      bottom: '3px',
      left: '50%',
      width: '18px',
      height: '3px',
      marginLeft: '-9px',
      borderRadius: '3px',
      backgroundColor: h.ember,
      boxShadow: '0 0 10px 1px rgba(228, 87, 46, 0.6)',
    },
  },
  label: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

interface BottomTabsProps {
  selected: string;
  moreOpen: boolean;
  onMore: () => void;
}

export function BottomTabs({ selected, moreOpen, onMore }: BottomTabsProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const entries = useNavGroups()
    .flatMap((group) => group.items)
    .filter((item) => (TAB_VALUES as readonly string[]).includes(item.value))
    .sort((a, b) => TAB_VALUES.indexOf(a.value as (typeof TAB_VALUES)[number]) - TAB_VALUES.indexOf(b.value as (typeof TAB_VALUES)[number]));
  const onTab = entries.some((item) => item.value === selected);

  return (
    <nav className={styles.bar} aria-label={t('nav.tabs')} data-motion="tabs">
      {entries.map((item) => (
        <Link
          key={item.value}
          to={item.path}
          className={mergeClasses(styles.tab, item.value === selected && styles.current)}
          aria-current={item.value === selected ? 'page' : undefined}
        >
          {item.icon}
          <span className={styles.label}>{t(`nav.tabLabels.${item.value}`)}</span>
        </Link>
      ))}
      <button
        type="button"
        className={mergeClasses(styles.tab, !onTab && styles.current)}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <MoreHorizontal20Regular />
        <span className={styles.label}>{t('nav.more')}</span>
      </button>
    </nav>
  );
}
