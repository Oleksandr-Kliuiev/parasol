import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, makeStyles, mergeClasses, useRestoreFocusTarget } from '@fluentui/react-components';
import {
  Add20Regular,
  Building20Regular,
  ChevronRight12Regular,
  DocumentText20Regular,
  Navigation20Regular,
  Search20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from './shellIcons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../auth/CurrentUserContext';
import { NotificationsBell } from '../features/notifications/NotificationsBell';
import { Magnetic } from '../shared/components/Magnetic';
import { h } from './hearth';
import { motionAllowed } from './motion';
import { useThemeMode } from './themeModeContext';

const useStyles = makeStyles({
  bar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    minHeight: '72px',
    marginInline: 'calc(var(--gutter) * -1)',
    paddingInline: 'var(--gutter)',
    marginBottom: '6px',
    '::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      zIndex: -1,
      backgroundColor: 'color-mix(in srgb, var(--h-bg) 82%, transparent)',
      backdropFilter: 'blur(14px) saturate(1.2)',
      borderBottom: `1px solid ${h.line}`,
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: '0.25s',
    },
    '@media (max-width: 767px)': { minHeight: '64px', gap: '10px', marginBottom: '4px' },
  },
  solid: { '::before': { opacity: 1 } },
  crumb: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, color: h.muted, fontWeight: 600, whiteSpace: 'nowrap' },
  section: { '@media (max-width: 767px)': { display: 'none' } },
  sep: { flexShrink: 0, '@media (max-width: 767px)': { display: 'none' } },
  page: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: h.text,
    fontFamily: h.display,
    fontSize: '17px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
  dev: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    height: '30px',
    paddingInline: '12px',
    borderRadius: '999px',
    backgroundColor: h.saffronSoft,
    color: h.saffronT,
    fontSize: '12px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    '::before': { content: '""', width: '7px', height: '7px', borderRadius: '50%', backgroundColor: h.saffron },
  },
  tools: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' },
  narrowOnly: { '@media (min-width: 901px)': { display: 'none' } },
  wideOnly: { '@media (max-width: 1100px)': { display: 'none' } },
  newButton: { '@media (max-width: 1100px)': { width: '36px', minWidth: '36px', maxWidth: '36px', paddingLeft: 0, paddingRight: 0 } },
});

/** Updates when the page has scrolled, so the bar gets its frosted background only over content. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 4);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return scrolled;
}

interface TopBarProps {
  section?: string;
  page: string;
  /** Shown where the menu is an overlay drawer (tablet); phones use the bottom tabs. */
  onMenu?: () => void;
  onSearch: () => void;
}

export function TopBar({ section, page, onMenu, onSearch }: TopBarProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const scrolled = useScrolled();
  const { dark, setMode } = useThemeMode();
  // The theme cross-fades where the browser can (View Transitions), instead of every colour jumping at once.
  const toggleTheme = () => {
    const apply = () => flushSync(() => setMode(dark ? 'light' : 'dark'));
    if (motionAllowed() && typeof document.startViewTransition === 'function') document.startViewTransition(apply);
    else apply();
  };
  const restoreFocusTarget = useRestoreFocusTarget();
  const canOrganization = useCan(Permissions.customersWrite);
  const canContract = useCan(Permissions.contractsWrite);
  const canQuote = useCan(Permissions.salesWrite);
  const creates = [
    canOrganization && { key: 'organization', label: t('myDay.newOrganization'), path: '/organizations/new', icon: <Building20Regular /> },
    canContract && { key: 'contract', label: t('contracts.new'), path: '/contracts/new', icon: <DocumentText20Regular /> },
    canQuote && { key: 'quote', label: t('quotes.new'), path: '/quotes/new', icon: <DocumentText20Regular /> },
  ].filter((entry): entry is { key: string; label: string; path: string; icon: React.ReactElement } => Boolean(entry));

  return (
    <header className={mergeClasses(styles.bar, scrolled && styles.solid)}>
      {onMenu && (
        <Button {...restoreFocusTarget} icon={<Navigation20Regular />} aria-label={t('nav.openMenu')} onClick={onMenu} />
      )}
      <div className={styles.crumb} data-motion="top-item">
        {section && (
          <>
            <span className={styles.section}>{section}</span>
            <ChevronRight12Regular className={styles.sep} aria-hidden />
          </>
        )}
        <span className={styles.page}>{page}</span>
      </div>
      {user.authMode === 'Development' && (
        <span className={mergeClasses(styles.dev, styles.wideOnly)} title={t('header.devMode')} data-motion="top-item">
          {t('header.devMode')}
        </span>
      )}
      <div className={styles.tools}>
        <span className={styles.narrowOnly}>
          <Magnetic pop motion="top-item">
            <Button icon={<Search20Regular />} aria-label={t('header.searchButton')} onClick={onSearch} />
          </Magnetic>
        </span>
        <Magnetic pop motion="top-item">
          <Button
            icon={dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />}
            aria-label={dark ? t('header.themeToLight') : t('header.themeToDark')}
            onClick={toggleTheme}
          />
        </Magnetic>
        <Magnetic pop motion="top-item">
          <NotificationsBell />
        </Magnetic>
        {/* Secondary: the page's own main action is the one primary button in view (Fluent 2: one primary per view). */}
        {creates.length > 0 && (
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button className={styles.newButton} size="small" icon={<Add20Regular />} aria-label={t('header.newMenu')} data-motion="top-item">
                <span className={styles.wideOnly}>{t('header.new')}</span>
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {creates.map((entry) => (
                  <MenuItem key={entry.key} icon={entry.icon} onClick={() => navigate(entry.path)}>
                    {entry.label}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
    </header>
  );
}
