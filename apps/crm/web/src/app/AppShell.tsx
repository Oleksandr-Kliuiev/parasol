import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router';
import { FluentProvider, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { currentUserQueryKey } from '../auth/CurrentUserContext';
import { changeLanguage as applyLanguage, type LanguageCode } from '../i18n';
import { ReverifyDialog } from '../auth/ReverifyDialog';
import { MaintenanceBanner } from '../features/operations/MaintenanceBanner';
import { BottomTabs, TAB_BAR_SPACE } from './BottomTabs';
import { h } from './hearth';
import { selectedNavValue, useNavGroups } from './navigation';
import { railThemeDarkPage, railThemeLightPage } from './railTheme';
import { SIDE_MINI, SIDE_WIDTH, Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useThemeMode } from './themeModeContext';
import { useSearchTypeAhead } from './searchTypeAhead';
import { toasterLoading } from './toaster';
import { RevealScopeProvider, ease, motionAllowed, reveal } from './motion';
import { useMediaQuery } from '../shared/utils/useMediaQuery';

const SearchDialog = lazy(async () => ({ default: (await import('./ShellOverlays')).SearchDialog }));
const MenuDrawer = lazy(async () => ({ default: (await import('./ShellOverlays')).MenuDrawer }));
// The toaster is not needed for the first paint: it loads with the overlays right after start-up, and notices raised
// before it listens wait for it.
const ShellToaster = lazy(async () => {
  toasterLoading();
  return { default: (await import('./ShellToaster')).ShellToaster };
});

const useStyles = makeStyles({
  root: {
    '--gutter': 'clamp(16px, 2vw, 32px)',
    display: 'grid',
    gridTemplateColumns: `${SIDE_WIDTH} minmax(0, 1fr)`,
    minHeight: '100dvh',
    // The rail colour runs the full height of the page, also below a short rail.
    backgroundImage: `linear-gradient(90deg, ${h.sideBg} ${SIDE_WIDTH}, transparent 0)`,
    '@media (max-width: 1100px) and (min-width: 901px)': {
      gridTemplateColumns: `232px minmax(0, 1fr)`,
      backgroundImage: `linear-gradient(90deg, ${h.sideBg} 232px, transparent 0)`,
    },
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)', backgroundImage: 'none' },
  },
  rootMini: {
    gridTemplateColumns: `${SIDE_MINI} minmax(0, 1fr)`,
    backgroundImage: `linear-gradient(90deg, ${h.sideBg} ${SIDE_MINI}, transparent 0)`,
    '@media (max-width: 1100px) and (min-width: 901px)': {
      gridTemplateColumns: `${SIDE_MINI} minmax(0, 1fr)`,
      backgroundImage: `linear-gradient(90deg, ${h.sideBg} ${SIDE_MINI}, transparent 0)`,
    },
  },
  // Two soft glows behind the page, as in the reference; fixed, so they never scroll with long lists. They drift slowly
  // (16 s and 21 s, back and forth), which keeps the page alive without asking for attention.
  glow: {
    position: 'fixed',
    // A modal's scroll lock widens the window by the scrollbar it hides (scrollLock.ts); the glows stay where they were.
    inset: '0 var(--h-locked-scrollbar, 0px) 0 0',
    zIndex: -1,
    pointerEvents: 'none',
    overflow: 'hidden',
    '::before': {
      animationName: { to: { transform: 'translate(-80px, 60px) scale(1.12)' } },
      animationDuration: '16s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      animationDirection: 'alternate',
      content: '""',
      position: 'absolute',
      width: '60vmax',
      height: '60vmax',
      top: '-26vmax',
      right: '-20vmax',
      borderRadius: '50%',
      backgroundImage: `radial-gradient(closest-side, ${'var(--h-glow-a)'}, transparent)`,
    },
    '::after': {
      animationName: { to: { transform: 'translate(70px, -50px) scale(0.92)' } },
      animationDuration: '21s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      animationDirection: 'alternate',
      content: '""',
      position: 'absolute',
      width: '54vmax',
      height: '54vmax',
      bottom: '-30vmax',
      left: '10vmax',
      borderRadius: '50%',
      backgroundImage: `radial-gradient(closest-side, ${'var(--h-glow-b)'}, transparent)`,
    },
  },
  rail: { position: 'sticky', top: 0, height: '100dvh', zIndex: 20, overflow: 'hidden', backgroundColor: h.sideBg },
  frame: { minWidth: 0, paddingInline: 'var(--gutter)', paddingBottom: '56px', overflowX: 'clip' },
  frameTabs: { paddingBottom: `calc(${TAB_BAR_SPACE} + env(safe-area-inset-bottom))` },
  content: {
    maxWidth: '1440px',
    marginInline: 'auto',
    outline: 'none',
  },
  skip: {
    position: 'fixed',
    left: '-9999px',
    top: tokens.spacingVerticalM,
    color: tokens.colorBrandForegroundLink,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    paddingBlock: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalM,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    ':focus': { left: tokens.spacingHorizontalM, top: tokens.spacingVerticalM, zIndex: 100 },
  },
});

const NARROW = '(max-width: 900px)';
// Below this width the menu moves to bottom tabs; "More" opens the same drawer.
const PHONE = '(max-width: 767px)';
const MINI_KEY = 'parasoll-rail';

function readMini() {
  try {
    return window.localStorage.getItem(MINI_KEY) === 'mini';
  } catch {
    return false;
  }
}

export function AppShell() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const navGroups = useNavGroups();
  const { dark } = useThemeMode();
  const narrow = useMediaQuery(NARROW);
  const phone = useMediaQuery(PHONE);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mini, setMini] = useState(readMini);
  // Loaded on first use and kept mounted afterwards, so closing animates and reopening is instant.
  const [searchUsed, setSearchUsed] = useState(false);
  const [drawerUsed, setDrawerUsed] = useState(false);
  const typeAhead = useSearchTypeAhead(setSearchOpen);
  const openSearch = useCallback(() => {
    typeAhead.start();
    setSearchUsed(true);
    setSearchOpen(true);
  }, [typeAhead]);
  const openDrawer = () => { setDrawerUsed(true); setDrawerOpen(true); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  // The shell enters once per visit, as in the reference: the glow fades up, the rail slides in with its items one by one,
  // the top bar drops into place and, on phones, the tab bar rises from the bottom edge.
  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const all = (selector: string) => document.querySelectorAll(selector);
    const animations = [
      ...reveal(document.querySelector('[data-motion="glow"]'), {}, { duration: 1200, easing: ease.outSoft }),
      ...reveal(document.querySelector('[data-motion="rail"]'), { x: -40 }, { duration: 800 }),
      ...reveal(all('[data-motion="rail-item"]'), { x: -10 }, { delay: 120, stagger: 25 }),
      ...reveal(all('[data-motion="top-item"]'), { y: -10 }, { delay: 200, stagger: 40 }),
      ...reveal(document.querySelector('[data-motion="tabs"]'), { yPercent: 120, opacity: 1 }, { delay: 250, duration: 700 }),
    ];
    return () => animations.forEach((animation) => animation.cancel());
  }, []);

  const selected = selectedNavValue(location.pathname);
  const group = navGroups.find((g) => g.items.some((item) => item.value === selected));
  const entry = group?.items.find((item) => item.value === selected);

  const go = (path: string) => (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
    setDrawerOpen(false);
  };

  const toggleMini = () => {
    setMini((value) => {
      try {
        window.localStorage.setItem(MINI_KEY, value ? 'full' : 'mini');
      } catch {
        // Storage may be refused; the choice then lasts for this page only.
      }
      return !value;
    });
  };

  const changeLanguage = async (code: string) => {
    // Save first: switching the UI before the request completes lets a quick reload lose the choice.
    await api.put('/api/v1/identity/me/preferences', { language: code });
    await applyLanguage(code as LanguageCode);
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
  };

  const signOut = async () => {
    const { data } = await api.post<{ signOutUrl: string }>('/bff/logout');
    // Nothing of this user's stays in memory for whoever uses the browser next (DEV-09).
    queryClient.clear();
    window.location.assign(data.signOutUrl);
  };

  const railTheme = dark ? railThemeDarkPage : railThemeLightPage;
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      selected={selected}
      mini={!inDrawer && mini}
      onToggleMini={inDrawer ? undefined : toggleMini}
      onSearch={() => {
        setDrawerOpen(false);
        openSearch();
      }}
      onNavigate={go}
      onLanguage={(code) => void changeLanguage(code)}
      onSignOut={() => void signOut()}
    />
  );

  return (
    <div className={mergeClasses(styles.root, !narrow && mini && styles.rootMini)}>
      <div className={styles.glow} aria-hidden data-motion="glow" />
      <a className={styles.skip} href="#main">
        {t('app.skipToContent')}
      </a>
      {!narrow && (
        <FluentProvider className={styles.rail} theme={railTheme} data-motion="rail">
          {sidebar(false)}
        </FluentProvider>
      )}
      {narrow && drawerUsed && (
        <Suspense fallback={null}>
          <MenuDrawer open={drawerOpen} onOpenChange={setDrawerOpen} theme={railTheme}>
            {sidebar(true)}
          </MenuDrawer>
        </Suspense>
      )}

      <div className={mergeClasses(styles.frame, phone && styles.frameTabs)}>
        <TopBar
          section={group && entry ? t(`nav.${group.label}`) : undefined}
          // A known page outside the person's menu is one they may not see: "No access", not "Page not found".
          page={entry ? t(`nav.${entry.label}`) : location.pathname.startsWith('/notifications') ? t('notifications.title')
            : selected ? t('errors.forbiddenTitle') : t('errors.notFoundTitle')}
          onMenu={narrow && !phone ? openDrawer : undefined}
          onSearch={openSearch}
        />
        <main id="main" className={styles.content} tabIndex={-1}>
          <MaintenanceBanner />
          <ReverifyDialog />
          <RevealScopeProvider value={location.pathname}>
            <Outlet />
          </RevealScopeProvider>
        </main>
      </div>
      {phone && <BottomTabs selected={selected} moreOpen={narrow && drawerOpen} onMore={openDrawer} />}

      {searchUsed && (
        <Suspense fallback={null}>
          <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} typeAhead={typeAhead} />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <ShellToaster phone={phone} />
      </Suspense>
      <ScrollRestoration />
    </div>
  );
}
