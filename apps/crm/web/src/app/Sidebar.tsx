import { Fragment, useEffect, cloneElement, useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router';
import {
  FluentProvider,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
} from '@fluentui/react-components';
import { ChevronDoubleLeft16Regular, ChevronUpDown16Regular, Search16Regular, SignOut20Regular } from './shellIcons';
import { useTranslation } from 'react-i18next';
import { useCurrentUser } from '../auth/CurrentUserContext';
import i18n, { languages } from '../i18n';
import { useScrollEdges } from '../shared/utils/useScrollEdges';
import { h } from './hearth';
import { darkTheme, lightTheme } from './theme';
import { useThemeMode } from './themeModeContext';
import { easeFn, motionAllowed, tween } from './motion';
import { useNavGroups } from './navigation';
import { searchShortcut } from './shortcut';

export const SIDE_WIDTH = '256px';
export const SIDE_MINI = '80px';

const useStyles = makeStyles({
  side: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxSizing: 'border-box',
    height: '100%',
    paddingBlock: '18px 14px',
    paddingInline: '14px',
    backgroundColor: h.sideBg,
    color: h.sideText,
    '@media (max-height: 900px)': { gap: '10px', paddingTop: '14px' },
  },
  mini: { paddingInline: '12px' },
  // flexShrink 0: in a menu taller than the window the head must not be squeezed (the collapse button then sat on the search).
  top: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexShrink: 0, minHeight: '44px', paddingInline: '6px 2px' },
  topMini: { flexDirection: 'column', gap: '12px', paddingInline: 0 },
  brand: { display: 'inline-flex', alignItems: 'center', gap: '11px', minWidth: 0, color: 'inherit', textDecorationLine: 'none' },
  mark: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '38px',
    height: '38px',
    borderRadius: '12px',
    backgroundColor: h.ember,
    color: '#FFFAF5',
    boxShadow: '0 8px 20px -8px rgba(228, 87, 46, 0.8)',
    // The parasol sways a little in the breeze, as the reference's flame flickers (stops with reduced motion).
    '& svg': {
      transformOrigin: '50% 46%',
      animationName: { from: { transform: 'rotate(-4deg)' }, to: { transform: 'rotate(4deg)' } },
      animationDuration: '3.2s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      animationDirection: 'alternate',
    },
  },
  name: { fontFamily: h.display, fontWeight: 700, fontSize: '19px', lineHeight: 1, letterSpacing: '-0.02em', whiteSpace: 'nowrap' },
  tagline: {
    display: 'block',
    marginTop: '3px',
    fontFamily: 'inherit',
    fontWeight: 600,
    fontSize: '12px',
    lineHeight: 1,
    letterSpacing: '0.01em',
    color: h.sideMuted,
  },
  collapse: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '30px',
    height: '30px',
    padding: 0,
    borderRadius: '9px',
    border: `1px solid ${h.sideLine}`,
    backgroundColor: 'transparent',
    color: h.sideMuted,
    cursor: 'pointer',
    ':hover': { color: h.sideText, backgroundColor: 'rgba(255, 255, 255, 0.06)' },
    ':focus-visible': { outline: `2px solid ${h.sideText}`, outlineOffset: '2px' },
  },
  flipped: { transform: 'rotate(180deg)' },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexShrink: 0,
    height: '42px',
    paddingInline: '12px',
    borderRadius: '12px',
    border: `1px solid ${h.sideLine}`,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    color: h.sideMuted,
    fontFamily: 'inherit',
    fontSize: '14px',
    fontWeight: 600,
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { color: h.sideText, backgroundColor: 'rgba(255, 255, 255, 0.09)' },
    ':focus-visible': { outline: `2px solid ${h.sideText}`, outlineOffset: '2px' },
  },
  searchMini: { justifyContent: 'center', paddingInline: 0 },
  searchLabel: { flex: 1 },
  kbd: {
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 600,
    color: h.sideMuted,
    border: `1px solid ${h.sideLine}`,
    borderRadius: '6px',
    paddingBlock: '2px',
    paddingInline: '6px',
  },
  nav: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flex: '1 1 auto',
    minHeight: 0,
    marginInline: '-4px',
    paddingInline: '4px',
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  group: {
    margin: 0,
    paddingBlock: '14px 6px',
    paddingInline: '12px',
    // 12 px rather than the reference's 11 px: the floor for running text in this product (ui-layout-audit small-text).
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    color: h.sideMuted,
    ':first-of-type': { paddingTop: '4px' },
    '@media (max-height: 900px)': { paddingBlock: '10px 4px' },
  },
  groupMini: { height: '1px', marginBlock: '10px', marginInline: '12px', padding: 0, backgroundColor: h.sideLine, overflow: 'hidden' },
  item: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexShrink: 0,
    height: '38px',
    paddingInline: '12px',
    borderRadius: '12px',
    color: h.sideMuted,
    fontSize: '14px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    textDecorationLine: 'none',
    ':hover': { color: h.sideText, backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    ':focus-visible': { outline: `2px solid ${h.sideText}`, outlineOffset: '-2px' },
    '& svg': { flexShrink: 0 },
  },
  itemMini: { justifyContent: 'center', paddingInline: 0 },
  // The current page: text and icon light up; the plate under it is the moving pill below.
  current: {
    color: h.sideText,
    ':hover': { backgroundColor: 'transparent' },
    '& svg': { color: '#FF8A62' },
  },
  // One pill for the whole menu that travels to the current page; its leading edge moves first, so it stretches on the
  // way and settles (the reference's menu). It sits under the links, which stay the click targets.
  pill: {
    position: 'absolute',
    top: 0,
    left: '4px',
    right: '4px',
    zIndex: 0,
    borderRadius: '12px',
    backgroundColor: h.sidePill,
    boxShadow: 'inset 0 1px rgba(255, 255, 255, 0.06)',
    pointerEvents: 'none',
    opacity: 0,
    '::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      top: '10px',
      bottom: '10px',
      width: '3px',
      borderRadius: '0 3px 3px 0',
      backgroundImage: `linear-gradient(#FF8A62, ${h.ember})`,
      boxShadow: '0 0 12px 2px rgba(228, 87, 46, 0.55)',
    },
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis' },
  external: { marginLeft: 'auto', color: h.faint, fontSize: '12px' },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
  me: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexShrink: 0,
    padding: '8px',
    border: 'none',
    borderRadius: '14px',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: 'rgba(255, 255, 255, 0.06)' },
    ':focus-visible': { outline: `2px solid ${h.sideText}`, outlineOffset: '2px' },
  },
  meMini: { justifyContent: 'center' },
  // Initials in a ring (the reference's online ring): a plain element, so the shell does not load Fluent's Avatar.
  avatar: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    backgroundColor: '#C4E7DD',
    color: '#0A4F41',
    fontSize: '13px',
    fontWeight: 700,
    boxShadow: `0 0 0 2px ${h.sideBg}, 0 0 0 3.5px rgba(10, 143, 116, 0.9)`,
  },
  who: { flex: 1, minWidth: 0 },
  whoName: { display: 'block', fontSize: '13.5px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  whoMeta: { display: 'block', fontSize: '12px', color: h.sideMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  chevron: { color: h.sideMuted, flexShrink: 0 },
  // The account menu opens over the page, so it wears the page's theme (as the reference's pop-up does), not the rail's.
  menuTheme: { backgroundColor: 'transparent', color: 'inherit' },
  menuName: { color: h.text, fontSize: '14px' },
});

/** The Parasoll mark: a parasol over a dot, drawn with the stroke of the menu icons. */
function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 11a9 9 0 0 1 18 0Z" />
      <path d="M12 11v7.5a2.5 2.5 0 0 1-5 0" />
      <path d="M12 2v1" />
    </svg>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)![0] : '')).toUpperCase();
}

interface SidebarProps {
  selected: string;
  mini: boolean;
  /** Undefined where the menu cannot be narrowed (the overlay drawer). */
  onToggleMini?: () => void;
  onSearch: () => void;
  onNavigate: (path: string) => (event: React.MouseEvent) => void;
  onLanguage: (code: string) => void;
  onSignOut: () => void;
}

/** Puts the pill under the link, from its top edge `t` to its bottom edge `b` (in the menu's own coordinates). */
function placePill(plate: HTMLElement, t: number, b: number) {
  plate.style.transform = `translateY(${t}px)`;
  plate.style.height = `${b - t}px`;
}

export function Sidebar({ selected, mini, onToggleMini, onSearch, onNavigate, onLanguage, onSignOut }: SidebarProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const user = useCurrentUser();
  const navGroups = useNavGroups();
  const { dark } = useThemeMode();
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const lastPill = useRef<{ top: number; bottom: number } | null>(null);
  // The pill travels to the current link: top and bottom edges move separately, the leading one faster, so it stretches
  // on the way and settles.
  useLayoutEffect(() => {
    const box = navRef.current;
    const plate = pillRef.current;
    if (!box || !plate) return;
    const link = box.querySelector<HTMLElement>('[aria-current="page"]');
    if (!link) {
      plate.style.opacity = '0';
      lastPill.current = null;
      return;
    }
    const top = link.offsetTop;
    const bottom = top + link.offsetHeight;
    const from = lastPill.current;
    lastPill.current = { top, bottom };
    plate.style.opacity = '1';
    if (!from || !motionAllowed()) {
      placePill(plate, top, bottom);
      const follow = new ResizeObserver(() => {
        lastPill.current = { top: link.offsetTop, bottom: link.offsetTop + link.offsetHeight };
        placePill(plate, lastPill.current.top, lastPill.current.bottom);
      });
      follow.observe(box);
      return () => follow.disconnect();
    }
    const down = top > from.top;
    const edge = { top: from.top, bottom: from.bottom, moving: true };
    const stopTop = tween(from.top, top, down ? 500 : 340, down ? easeFn.inOut : easeFn.out, (value) => {
      edge.top = value;
      placePill(plate, edge.top, edge.bottom);
    });
    const stopBottom = tween(from.bottom, bottom, down ? 340 : 500, down ? easeFn.out : easeFn.inOut, (value) => {
      edge.bottom = value;
      placePill(plate, edge.top, edge.bottom);
    });
    const settle = window.setTimeout(() => { edge.moving = false; }, 520);
    // The menu can still change size after this frame (the narrow rail, a late font, a resized window): follow the link.
    const follow = new ResizeObserver(() => {
      if (edge.moving) return;
      lastPill.current = { top: link.offsetTop, bottom: link.offsetTop + link.offsetHeight };
      placePill(plate, lastPill.current.top, lastPill.current.bottom);
    });
    follow.observe(box);
    return () => {
      stopTop();
      stopBottom();
      window.clearTimeout(settle);
      follow.disconnect();
      // A new page chosen mid-way starts from where the pill is, not from where it was going.
      if (edge.moving) lastPill.current = { top: edge.top, bottom: edge.bottom };
    };
  }, [selected, mini]);
  // The current page's entry stays in sight: on a short window the list scrolls under the account card, and an entry
  // hidden there leaves the person without "you are here" (seen at 1440×900 on the SLA report).
  useEffect(() => {
    const box = navRef.current;
    const link = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !link) return;
    const top = link.offsetTop; const bottom = top + link.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 8);
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }, [selected]);
  const edges = useScrollEdges(navRef, 'y', `${navGroups.length}-${mini}`);
  // In the narrow menu the label is hidden visually but stays the link's name; the browser tooltip shows it on hover.
  const tip = (label: string, child: React.ReactElement<{ title?: string }>) =>
    mini ? cloneElement(child, { title: label }) : child;

  return (
    <div className={mergeClasses(styles.side, mini && styles.mini)}>
      <div className={mergeClasses(styles.top, mini && styles.topMini)} data-motion="rail-item">
        <Link to="/" className={styles.brand} onClick={onNavigate('/')} aria-label={t('app.name')}>
          <span className={styles.mark}>
            <BrandMark />
          </span>
          {!mini && (
            <span className={styles.name} aria-hidden>
              {t('app.name')}
              <small className={styles.tagline}>{t('app.tagline')}</small>
            </span>
          )}
        </Link>
        {onToggleMini && (
          <button
            type="button"
            className={styles.collapse}
            onClick={onToggleMini}
            aria-label={mini ? t('nav.expand') : t('nav.collapse')}
            aria-pressed={mini}
          >
            <ChevronDoubleLeft16Regular className={mini ? styles.flipped : undefined} />
          </button>
        )}
      </div>

      {tip(
        t('header.searchButton'),
        <button type="button" className={mergeClasses(styles.search, mini && styles.searchMini)} onClick={onSearch} aria-label={t('header.searchButton')} aria-keyshortcuts="Control+K Meta+K" data-motion="rail-item">
          <Search16Regular aria-hidden />
          <span className={mini ? styles.hidden : styles.searchLabel}>{t('header.searchButton')}</span>
          {!mini && <kbd className={styles.kbd} aria-hidden>{searchShortcut}</kbd>}
        </button>,
      )}

      <nav ref={navRef} className={styles.nav} style={edges.style} aria-label={t('nav.mainMenu')}>
        <span ref={pillRef} className={styles.pill} aria-hidden />
        {navGroups.map((group) => (
          <Fragment key={group.key}>
            <p className={mergeClasses(styles.group, mini && styles.groupMini)} data-motion="rail-item">
              <span className={mini ? styles.hidden : undefined}>{t(`nav.${group.label}`)}</span>
            </p>
            {group.items.map((item) => {
              const label = t(`nav.${item.label}`);
              const current = item.value === selected;
              const className = mergeClasses(styles.item, mini && styles.itemMini, current && styles.current);
              const content = (
                <>
                  {item.icon}
                  <span className={mini ? styles.hidden : styles.label}>{label}</span>
                </>
              );
              return (
                <Fragment key={item.value}>
                  {tip(
                    label,
                    item.external ? (
                      // A page outside the app opens in a new tab, and says so before the click (WCAG 3.2.5 practice).
                      <a href={item.path} target="_blank" rel="noopener" className={className} data-motion="rail-item">
                        {content}
                        <span className={mini ? styles.hidden : styles.external} aria-hidden>↗</span>
                        <span className={styles.hidden}>{t('nav.opensNewTab')}</span>
                      </a>
                    ) : (
                      <Link to={item.path} className={className} aria-current={current ? 'page' : undefined} onClick={onNavigate(item.path)} data-motion="rail-item">
                        {content}
                      </Link>
                    ),
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </nav>

      <Menu positioning={{ position: 'after', align: 'bottom' }}>
        <MenuTrigger disableButtonEnhancement>
          <button type="button" className={mergeClasses(styles.me, mini && styles.meMini)} aria-label={`${user.displayName} · ${t('header.account')}`} data-motion="rail-item">
            <span className={styles.avatar} aria-hidden>{initials(user.displayName)}</span>
            {!mini && (
              <>
                <span className={styles.who}>
                  <span className={styles.whoName}>{user.displayName}</span>
                  {user.email && <span className={styles.whoMeta}>{user.email}</span>}
                </span>
                <ChevronUpDown16Regular className={styles.chevron} aria-hidden />
              </>
            )}
          </button>
        </MenuTrigger>
        <MenuPopover>
          <FluentProvider theme={dark ? darkTheme : lightTheme} className={styles.menuTheme}>
          <MenuList
            checkedValues={{ language: [i18n.language] }}
            onCheckedValueChange={(_, data) => {
              const code = data.checkedItems[0];
              if (code) onLanguage(code);
            }}
          >
            <MenuGroup>
              <MenuGroupHeader>
                <Text weight="semibold" className={styles.menuName}>{user.displayName}</Text>
              </MenuGroupHeader>
              {user.email && <MenuGroupHeader>{user.email}</MenuGroupHeader>}
            </MenuGroup>
            <MenuDivider />
            <MenuGroup>
              <MenuGroupHeader>{t('header.language')}</MenuGroupHeader>
              {languages.map((language) => (
                <MenuItemRadio key={language.code} name="language" value={language.code}>
                  {language.label}
                </MenuItemRadio>
              ))}
            </MenuGroup>
            <MenuDivider />
            <MenuItem icon={<SignOut20Regular />} onClick={onSignOut}>
              {t('header.signOut')}
            </MenuItem>
          </MenuList>
          </FluentProvider>
        </MenuPopover>
      </Menu>
    </div>
  );
}
