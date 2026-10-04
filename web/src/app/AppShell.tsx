import { useEffect, useState } from 'react';
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
  Text,
  Toaster,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  Board20Regular,
  BoardSplit20Regular,
  ContactCard20Regular,
  DataFunnel20Regular,
  DataTrending20Regular,
  DocumentBulletList20Regular,
  Receipt20Regular,
  KeyMultiple20Regular,
  ArrowImport20Regular,
  DataUsage20Regular,
  ShieldTask20Regular,
  TaskListSquareLtr20Regular,
  TextboxSettings20Regular,
  Box20Regular,
  Building20Regular,
  DocumentText20Regular,
  Clock20Regular,
  PersonSettings20Regular,
  PersonLock20Regular,
  DocumentSearch20Regular,
  LockClosed20Regular,
  Navigation20Regular,
  People20Regular,
  PlugConnected20Regular,
  ArrowSwap20Regular,
  SignOut20Regular,
  Timer20Regular,
  Wrench20Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Permissions, currentUserQueryKey, useCan, useCurrentUser } from '../auth/CurrentUserContext';
import i18n, { changeLanguage as applyLanguage, languages, type LanguageCode } from '../i18n';
import { NotificationsBell } from '../features/notifications/NotificationsBell';
import { MaintenanceBanner } from '../features/operations/MaintenanceBanner';
import { GlobalSearch } from './GlobalSearch';
import { TOASTER_ID } from './toaster';

const useStyles = makeStyles({
  root: { display: 'flex', minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
  drawer: { height: '100vh', position: 'sticky', top: 0 },
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
  spacer: { flex: 1 },
  content: {
    paddingInline: tokens.spacingHorizontalXXL,
    paddingBlock: tokens.spacingVerticalXL,
    maxWidth: '1280px',
    width: '100%',
    boxSizing: 'border-box',
    '@media (max-width: 600px)': { paddingInline: tokens.spacingHorizontalL },
  },
  skip: {
    position: 'absolute',
    left: '-9999px',
    ':focus': { left: tokens.spacingHorizontalM, top: tokens.spacingVerticalM, zIndex: 100 },
  },
});

const NARROW = '(max-width: 900px)';

export function AppShell() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const canAudit = useCan(Permissions.auditRead);
  const canUsers = useCan(Permissions.usersRead);
  const canJobs = useCan(Permissions.integrationsManage);
  const canCatalog = useCan(Permissions.catalogRead);
  const canContracts = useCan(Permissions.contractsRead);
  const canOwnTime = useCan(Permissions.timeOwn);
  const canReadTime = useCan(Permissions.timeRead);
  const canManageTime = useCan(Permissions.timeManage);
  const canSales = useCan(Permissions.salesRead);
  const canSalesWrite = useCan(Permissions.salesWrite);
  const canLicensing = useCan(Permissions.licensingRead);
  const canProjects = useCan(Permissions.projectsRead);
  const canBilling = useCan(Permissions.billingRead);
  const canReports = useCan(Permissions.reportsRead);
  const canMargins = useCan(Permissions.financeCostRead);
  const canService = useCan(Permissions.serviceRead);
  const canCustomFields = useCan(Permissions.customFieldsManage);
  const canDeleteCustomers = useCan(Permissions.customersDelete);
  const canPrivacy = useCan(Permissions.privacyManage);
  const canMaintenance = useCan(Permissions.operationsMaintenance);
  const canTime = canOwnTime || canReadTime;
  const canTimeAll = canReadTime || canManageTime;
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


  const selected = location.pathname.startsWith('/organizations') || location.pathname.startsWith('/contacts')
    ? 'organizations'
    : location.pathname.startsWith('/dashboard')
      ? 'dashboard'
      : location.pathname.startsWith('/billing/invoices')
      ? 'invoices'
      : location.pathname.startsWith('/billing')
        ? 'billing'
        : location.pathname.startsWith('/quotes')
      ? 'quotes'
      : location.pathname.startsWith('/admin/quote-templates')
      ? 'quote-templates'
      : location.pathname.startsWith('/pipeline')
      ? 'pipeline'
      : location.pathname.startsWith('/sales/leads')
        ? 'leads'
        : location.pathname.startsWith('/projects')
          ? 'projects'
          : location.pathname.startsWith('/licenses')
          ? 'licenses'
          : location.pathname.startsWith('/admin/pipeline')
            ? 'pipeline-stages'
            : location.pathname.startsWith('/time/entries')
      ? 'time-entries'
      : location.pathname.startsWith('/time')
        ? 'timesheet'
        : location.pathname.startsWith('/admin/technicians')
          ? 'technicians'
          : location.pathname.startsWith('/contracts')
      ? 'contracts'
      : location.pathname.startsWith('/catalog')
        ? 'catalog'
        : location.pathname.startsWith('/admin/audit')
      ? 'audit'
      : location.pathname.startsWith('/admin/record-access')
        ? 'record-access'
      : location.pathname.startsWith('/admin/users')
        ? 'users'
        : location.pathname.startsWith('/admin/integrations')
          ? 'integrations'
          : location.pathname.startsWith('/admin/mappings')
            ? 'mappings'
            : location.pathname.startsWith('/admin/migration')
              ? 'migration'
              : location.pathname.startsWith('/admin/custom-fields')
              ? 'custom-fields'
              : location.pathname.startsWith('/admin/privacy')
              ? 'privacy'
              : location.pathname.startsWith('/admin/maintenance')
              ? 'maintenance'
              : location.pathname.startsWith('/reports/margins')
                ? 'margins'
                : location.pathname.startsWith('/service/sla')
                  ? 'sla'
                  : 'my-day';

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
              V
            </span>
            {t('app.name')}
          </div>
        </NavDrawerHeader>
        <NavDrawerBody>
          <NavItem href="/" value="my-day" icon={<Board20Regular />} onClick={go('/')}>
            {t('nav.myDay')}
          </NavItem>
          {canReports && (
            <NavItem href="/dashboard" value="dashboard" icon={<DataTrending20Regular />} onClick={go('/dashboard')}>
              {t('nav.dashboard')}
            </NavItem>
          )}
          <NavItem href="/organizations" value="organizations" icon={<Building20Regular />} onClick={go('/organizations')}>
            {t('nav.organizations')}
          </NavItem>
          {canContracts && (
            <NavItem href="/contracts" value="contracts" icon={<DocumentText20Regular />} onClick={go('/contracts')}>
              {t('nav.contracts')}
            </NavItem>
          )}
          {canSales && (
            <NavItem href="/pipeline" value="pipeline" icon={<DataFunnel20Regular />} onClick={go('/pipeline')}>
              {t('nav.pipeline')}
            </NavItem>
          )}
          {canSales && (
            <NavItem href="/sales/leads" value="leads" icon={<ContactCard20Regular />} onClick={go('/sales/leads')}>
              {t('nav.leads')}
            </NavItem>
          )}
          {canSales && (
            <NavItem href="/quotes" value="quotes" icon={<DocumentText20Regular />} onClick={go('/quotes')}>
              {t('nav.quotes')}
            </NavItem>
          )}
          {canLicensing && (
            <NavItem href="/licenses" value="licenses" icon={<KeyMultiple20Regular />} onClick={go('/licenses')}>
              {t('nav.licenses')}
            </NavItem>
          )}
          {canProjects && (
            <NavItem href="/projects" value="projects" icon={<TaskListSquareLtr20Regular />} onClick={go('/projects')}>
              {t('nav.projects')}
            </NavItem>
          )}
          {canService && (
            <NavItem href="/service/sla" value="sla" icon={<ShieldTask20Regular />} onClick={go('/service/sla')}>
              {t('nav.sla')}
            </NavItem>
          )}
          {canMargins && (
            <NavItem href="/reports/margins" value="margins" icon={<DataUsage20Regular />} onClick={go('/reports/margins')}>
              {t('nav.margins')}
            </NavItem>
          )}
          {canBilling && (
            <NavItem href="/billing" value="billing" icon={<DocumentBulletList20Regular />} onClick={go('/billing')}>
              {t('nav.billing')}
            </NavItem>
          )}
          {canBilling && (
            <NavItem href="/billing/invoices" value="invoices" icon={<Receipt20Regular />} onClick={go('/billing/invoices')}>
              {t('nav.invoices')}
            </NavItem>
          )}
          {canTime && (
            <NavItem href="/time" value="timesheet" icon={<Clock20Regular />} onClick={go('/time')}>
              {t('nav.timesheet')}
            </NavItem>
          )}
          {canTimeAll && (
            <NavItem href="/time/entries" value="time-entries" icon={<Clock20Regular />} onClick={go('/time/entries')}>
              {t('nav.timeEntries')}
            </NavItem>
          )}
          {canCatalog && (
            <NavItem href="/catalog" value="catalog" icon={<Box20Regular />} onClick={go('/catalog')}>
              {t('nav.catalog')}
            </NavItem>
          )}
          {(canAudit || canUsers || canJobs || canSalesWrite || canPrivacy || canMaintenance) && (
            <>
              <NavSectionHeader>{t('nav.admin')}</NavSectionHeader>
              {canAudit && (
                <NavItem href="/admin/audit" value="audit" icon={<DocumentSearch20Regular />} onClick={go('/admin/audit')}>
                  {t('nav.audit')}
                </NavItem>
              )}
              {canAudit && (
                <NavItem href="/admin/record-access" value="record-access" icon={<LockClosed20Regular />} onClick={go('/admin/record-access')}>
                  {t('nav.recordAccess')}
                </NavItem>
              )}
              {canUsers && (
                <NavItem href="/admin/users" value="users" icon={<People20Regular />} onClick={go('/admin/users')}>
                  {t('nav.users')}
                </NavItem>
              )}
              {canJobs && (
                <NavItem href="/admin/integrations" value="integrations" icon={<PlugConnected20Regular />} onClick={go('/admin/integrations')}>
                  {t('nav.integrations')}
                </NavItem>
              )}
              {canSalesWrite && (
                <NavItem href="/admin/quote-templates" value="quote-templates" icon={<DocumentText20Regular />} onClick={go('/admin/quote-templates')}>
                  {t('nav.quoteTemplates')}
                </NavItem>
              )}
              {canSalesWrite && (
                <NavItem href="/admin/pipeline" value="pipeline-stages" icon={<BoardSplit20Regular />} onClick={go('/admin/pipeline')}>
                  {t('nav.pipelineStages')}
                </NavItem>
              )}
              {canJobs && (
                <NavItem href="/admin/technicians" value="technicians" icon={<PersonSettings20Regular />} onClick={go('/admin/technicians')}>
                  {t('nav.technicians')}
                </NavItem>
              )}
              {canDeleteCustomers && (
                <NavItem href="/admin/migration" value="migration" icon={<ArrowImport20Regular />} onClick={go('/admin/migration')}>
                  {t('nav.migration')}
                </NavItem>
              )}
              {canPrivacy && (
                <NavItem href="/admin/privacy" value="privacy" icon={<PersonLock20Regular />} onClick={go('/admin/privacy')}>
                  {t('nav.privacy')}
                </NavItem>
              )}
              {canCustomFields && (
                <NavItem href="/admin/custom-fields" value="custom-fields" icon={<TextboxSettings20Regular />} onClick={go('/admin/custom-fields')}>
                  {t('nav.customFields')}
                </NavItem>
              )}
              {canJobs && (
                <NavItem href="/admin/mappings" value="mappings" icon={<ArrowSwap20Regular />} onClick={go('/admin/mappings')}>
                  {t('nav.mappings')}
                </NavItem>
              )}
              {canJobs && (
                <NavItem href="/admin/jobs" value="jobs" icon={<Timer20Regular />} target="_blank" rel="noopener">
                  {t('nav.jobs')}
                </NavItem>
              )}
              {canMaintenance && (
                <NavItem href="/admin/maintenance" value="maintenance" icon={<Wrench20Regular />} onClick={go('/admin/maintenance')}>
                  {t('nav.maintenance')}
                </NavItem>
              )}
            </>
          )}
        </NavDrawerBody>
      </NavDrawer>

      <div className={styles.main}>
        <header className={styles.header}>
          {(isNarrow || !drawerOpen) && (
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
              <Button appearance="subtle" aria-label={user.displayName}>
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
        <main id="main" className={styles.content} tabIndex={-1}>
          <MaintenanceBanner />
          <Outlet />
        </main>
      </div>
      <Toaster toasterId={TOASTER_ID} position="top-end" />
      <ScrollRestoration />
    </div>
  );
}
