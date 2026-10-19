import { Link } from 'react-router';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useNavGroups } from './navigation';

/**
 * Phone tabs (UX concept §4): the three places used all day, the rest sits behind "More" (the full menu). A tab has a
 * short label of its own (`nav.tabLabels`) so that it fits a 320 px screen without ellipsis.
 */
const TAB_VALUES = ['my-day', 'organizations', 'timesheet'] as const;
export const TAB_BAR_HEIGHT = '56px';

const useStyles = makeStyles({
  bar: {
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    zIndex: 15,
    display: 'flex',
    boxSizing: 'content-box',
    height: TAB_BAR_HEIGHT,
    paddingBottom: 'env(safe-area-inset-bottom)',
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tab: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalXXS,
    paddingInline: tokens.spacingHorizontalXS,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    textDecorationLine: 'none',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  current: { color: tokens.colorBrandForegroundLink, fontWeight: tokens.fontWeightSemibold },
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
    <nav className={styles.bar} aria-label={t('nav.tabs')}>
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
