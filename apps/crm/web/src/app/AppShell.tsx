import { Fragment, useEffect, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router';
import {
  Avatar,
  Badge,
  Button,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  NavDrawer,
  NavDrawerBody,
  NavDrawerHeader,
  NavItem,
  NavSectionHeader,
  FluentProvider,
  Text,
  Toaster,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Navigation20Regular, SignOut20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { currentUserQueryKey, useCurrentUser } from '../auth/CurrentUserContext';
import i18n, { changeLanguage as applyLanguage, languages, type LanguageCode } from '../i18n';
import { ReverifyDialog } from '../auth/ReverifyDialog';
import { NotificationsBell } from '../features/notifications/NotificationsBell';
import { MaintenanceBanner } from '../features/operations/MaintenanceBanner';
import { BottomTabs, TAB_BAR_HEIGHT } from './BottomTabs';
import { GlobalSearch } from './GlobalSearch';
import { selectedNavValue, useNavGroups } from './navigation';
import { usePrefersDark } from './usePrefersDark';
import { railThemeDarkPage, railThemeLightPage } from './railTheme';
import { TOASTER_ID } from './toaster';
import { useMediaQuery } from '../shared/utils/useMediaQuery';

const useStyles = makeStyles({
  root: { display: 'flex', minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
  rail: { position: 'sticky', top: 0, alignSelf: 'flex-start', height: '100vh', flexShrink: 0 },
  drawer: { height: '100vh' },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  brandMark: {
    display: 'grid',
    placeItems: 'center',
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightBold,
  },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingInline: tokens.spacingHorizontalL,
    height: '52px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  spacer: { flex: 1, '@media (max-width: 767px)': { flex: 0 } },
  avatarButton: { minWidth: '40px', paddingInline: tokens.spacingHorizontalXS },
  content: {
    paddingInline: tokens.spacingHorizontalXXL,
    paddingBlock: tokens.spacingVerticalXL,
    maxWidth: '1280px',
    width: '100%',
    boxSizing: 'border-box',
    '@media (max-width: 600px)': { paddingInline: tokens.spacingHorizontalL },
  },
  contentWithTabs: { paddingBottom: `calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom) + ${tokens.spacingVerticalL})` },
  skip: {
    position: 'absolute',
    left: '-9999px',
    color: tokens.colorBrandForegroundLink,
    backgroundColor: tokens.colorNeutralBackground1,
    paddingBlock: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    ':focus': { left: tokens.spacingHorizontalM, top: tokens.spacingVerticalM, zIndex: 100 },
  },
});

const NARROW = '(max-width: 900px)';
// Below this width the menu moves to bottom tabs; "More" opens the same drawer.
const PHONE = '(max-width: 767px)';

export function AppShell() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const navGroups = useNavGroups();
  const prefersDark = usePrefersDark();
  const phone = useMediaQuery(PHONE);
  const restoreFocusTarget = useRestoreFocusTarget();

  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [drawerOpen, setDrawerOpen] = useState(() => !window.matchMedia(NARROW).matches);

  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const onChange = () => {
      setIsNarrow(media.matches);
      setDrawerOpen(!media.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);


  const selected = selectedNavValue(location.pathname);

  const go = (path: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    navigate(path);
    if (isNarrow) setDrawerOpen(false);
  };

  const changeLanguage = async (code: string) => {
    // Save first: switching the UI before the request completes lets a quick reload lose the choice.
    await api.put('/api/v1/identity/me/preferences', { language: code });
    await applyLanguage(code as LanguageCode);
    document.documentElement.lang = code;
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
  };

  const signOut = async () => {
    const { data } = await api.post<{ signOutUrl: string }>('/bff/logout');
    // Nothing of this user's stays in memory for whoever uses the browser next (DEV-09).
    queryClient.clear();
    window.location.assign(data.signOutUrl);
  };

  return (
    <div className={styles.root}>
      <a className={styles.skip} href="#main">
        {t('app.skipToContent')}
      </a>
      <FluentProvider className={styles.rail} theme={prefersDark ? railThemeDarkPage : railThemeLightPage}>
        <NavDrawer
          className={styles.drawer}
          open={drawerOpen}
          type={isNarrow ? 'overlay' : 'inline'}
          onOpenChange={(_, data) => setDrawerOpen(data.open)}
          selectedValue={selected}
          density="small"
        >
          <NavDrawerHeader>
            <div className={styles.brand}>
              <span className={styles.brandMark} aria-hidden>
                P
              </span>
              {t('app.name')}
            </div>
          </NavDrawerHeader>
          <NavDrawerBody>
            {navGroups.map((group) => (
              <Fragment key={group.key}>
                <NavSectionHeader>{t(`nav.${group.label}`)}</NavSectionHeader>
                {group.items.map((item) => (
                  <NavItem
                    key={item.value}
                    href={item.path}
                    value={item.value}
                    icon={item.icon}
                    {...(item.external ? { target: '_blank', rel: 'noopener' } : { onClick: go(item.path) })}
                  >
                    {t(`nav.${item.label}`)}
                  </NavItem>
                ))}
              </Fragment>
            ))}
          </NavDrawerBody>
        </NavDrawer>
      </FluentProvider>

      <div className={styles.main}>
        <header className={styles.header}>
          {!phone && (isNarrow || !drawerOpen) && (
            <Button
              {...restoreFocusTarget}
              appearance="subtle"
              icon={<Navigation20Regular />}
              aria-label={t('nav.openMenu')}
              onClick={() => setDrawerOpen(true)}
            />
          )}
          <GlobalSearch />
          <div className={styles.spacer} />
          <NotificationsBell />
          {user.authMode === 'Development' && (
            <Badge appearance="tint" color="warning" title={t('header.devMode')}>
              {isNarrow ? 'Dev' : t('header.devMode')}
            </Badge>
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button className={styles.avatarButton} appearance="subtle" aria-label={user.displayName}>
                <Avatar name={user.displayName} size={28} color="colorful" />
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList
                checkedValues={{ language: [i18n.language] }}
                onCheckedValueChange={(_, data) => {
                  const code = data.checkedItems[0];
                  if (code) void changeLanguage(code);
                }}
              >
                <MenuGroup>
                  <MenuGroupHeader>
                    <Text weight="semibold">{user.displayName}</Text>
                  </MenuGroupHeader>
                  {user.email && <MenuGroupHeader>{user.email}</MenuGroupHeader>}
                  <MenuGroupHeader>{t('parasol.employeeRoles')}: {user.roles.map(role => t(`parasol.roles.${role.replace('Crm.', '')}`)).join(', ')}</MenuGroupHeader>
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
                <MenuItem icon={<SignOut20Regular />} onClick={() => void signOut()}>
                  {t('header.signOut')}
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </header>
        <main id="main" className={mergeClasses(styles.content, phone && styles.contentWithTabs)} tabIndex={-1}>
          <MaintenanceBanner />
          <ReverifyDialog />
          <Outlet />
        </main>
      </div>
      {phone && <BottomTabs selected={selected} moreOpen={drawerOpen} onMore={() => setDrawerOpen(true)} />}
      <Toaster toasterId={TOASTER_ID} position="top-end" />
      <ScrollRestoration />
    </div>
  );
}
