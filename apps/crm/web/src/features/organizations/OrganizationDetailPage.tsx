import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  Building16Regular, ChevronDown16Regular, Clock16Regular, ContactCard16Regular, Delete20Regular, Edit20Regular, Location16Regular, MoreHorizontal20Regular,
  PeopleTeam16Regular, Person16Regular, Receipt16Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { Organization } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { DetailList, Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { useNotify } from '../../shared/components/useNotify';
import { formatAddress, formatDate, formatDateTime } from '../../shared/utils/format';
import { localeOf } from '../../i18n';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { HistoryList } from '../audit/HistoryList';
import { ContactsTab } from '../contacts/ContactsTab';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useDeleteOrganization, useOrganization } from './api';
import { useDuplicates } from './duplicatesApi';
import { LinkedSystemsPanel } from '../integrations/LinkedSystemsPanel';
import { OrganizationContractsTab } from '../contracts/OrganizationContractsTab';
import { OperationsTab } from '../service/OperationsTab';
import { BackupTab } from '../backup/BackupTab';
import { OrganizationDealsTab } from '../sales/OrganizationDealsTab';
import { OrganizationMailTab } from '../activities/OrganizationMailTab';
import { OrganizationDocumentsTab } from '../documents/OrganizationDocumentsTab';
import { OrganizationLicensesTab } from '../licensing/LicensesPage';
import { OrganizationProjectsTab } from '../projects/OrganizationProjectsTab';
import { OrganizationGroupPanel } from './OrganizationGroupPanel';
import { CustomFieldsPanel } from '../customfields/CustomFieldsPanel';
import { ActivityTimeline } from '../activities/ActivityTimeline';
import { activitySelection } from '../activities/activityNavigation';
import { OrganizationInvoicesTab } from '../billing/InvoicesPage';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { useCustomerTabVisibility } from './useCustomerTabVisibility';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { h } from '../../app/hearth';
import { useReveal } from '../../app/motion';
import { ProfileHeader } from './ProfileHeader';
import { AppLink } from '../../shared/components/AppLink';
import { CustomerHighlights } from './CustomerHighlights';
import { useOrganizationContacts } from '../contacts/api';

const useStyles = makeStyles({
  // The tab bar scrolls sideways without widening a phone; URL-selected tabs are revealed too.
  tabs: { marginBottom: '20px', overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
  stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px', alignItems: 'start', minWidth: 0 },
  // The records card: sections under one hairline each; every section stays its own region with its own heading.
  records: {
    backgroundColor: h.surface,
    border: `1px solid ${h.line}`,
    borderRadius: '20px',
    boxShadow: tokens.shadow4,
    minWidth: 0,
    overflow: 'hidden',
  },
  section: {
    paddingTop: '16px',
    paddingBottom: '16px',
    paddingLeft: '20px',
    paddingRight: '20px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none', paddingTop: '18px' },
    ':last-child': { paddingBottom: '20px' },
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' },
  },
  // One label column for the whole card, so the values of all sections start on the same line.
  facts: { gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr)', '@media (max-width: 400px)': { gridTemplateColumns: 'minmax(0, 1fr)', rowGap: '2px' } },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: 0,
    marginBottom: '12px',
    fontFamily: h.display,
    fontSize: '15px',
    lineHeight: '20px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    '& svg': { width: '16px', height: '16px', color: h.faint },
  },
  orgNumber: { fontVariantNumeric: 'tabular-nums', color: 'inherit', fontSize: 'inherit' },
  // "More" reads like the other sections, its chevron after the word as on any menu button.
  more: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  // The fields nobody filled in, named in one quiet line under the filled ones instead of a column of dashes.
  recordFacts: { display: 'grid', gap: '10px', minWidth: 0 },
  missing: { color: h.muted, fontSize: '13px', lineHeight: '19px' },
  strong: { color: h.text, fontWeight: 600 },
  domains: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
});

/** The value of the "More" tab: it opens the menu of the occasional sections and is never itself selected. */
const MORE = '__more';
const dailyTabs = ['overview', 'contacts', 'contracts', 'drift', 'invoices', 'activities'] as const;
const occasionalTabs = ['backup', 'deals', 'licenses', 'projects', 'mail', 'documents', 'history'] as const;

type TabValue =
  | 'overview'
  | 'contacts'
  | 'contracts'
  | 'drift'
  | 'backup'
  | 'deals'
  | 'licenses'
  | 'projects'
  | 'invoices'
  | 'activities'
  | 'mail'
  | 'documents'
  | 'history';

export function OrganizationDetailPage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // The Drift tab was called Service until M38: links to ?tab=service still open it, and the address then says drift.
  const requestedTab = params.get('tab');
  const tab = (requestedTab === 'service' ? 'drift' : (requestedTab as TabValue | null)) ?? 'overview';
  const { data, error, isPending, refetch } = useOrganization(id);
  const canEdit = useCan(Permissions.customersWrite);
  const canDelete = useCan(Permissions.customersDelete);
  const canContracts = useCan(Permissions.contractsRead);
  const canService = useCan(Permissions.serviceRead);
  const canSales = useCan(Permissions.salesRead);
  const canLicensing = useCan(Permissions.licensingRead);
  const canActivities = useCan(Permissions.activitiesRead);
  const canBilling = useCan(Permissions.billingRead);
  const canProjects = useCan(Permissions.projectsRead);
  const remove = useDeleteOrganization();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const duplicates = useDuplicates(id);
  const mergedIntoId = error instanceof ApiError && error.code === 'CUS_ORGANIZATION_MERGED' ? String(error.problem.mergedIntoId) : null;
  const tabScope = JSON.stringify([id, i18n.resolvedLanguage, canContracts, canService, canSales,
    canLicensing, canProjects, canBilling, canActivities]);
  const tabs = useCustomerTabVisibility(tab, tabScope, !isPending && !error && !mergedIntoId);
  // Six sections for every day in the row, the rest one step away under "More" (UX 2026, В4); a section opened from there
  // joins the row, so the row always names where you are.
  const permitted = (value: TabValue) => ({ contracts: canContracts, drift: canService, backup: canService, deals: canSales, licenses: canLicensing,
    projects: canProjects, invoices: canBilling, activities: canActivities, mail: canActivities } as Partial<Record<TabValue, boolean>>)[value] ?? true;
  const rowTabs = [...dailyTabs.filter(permitted), ...occasionalTabs.filter((value) => value === tab && permitted(value))];
  const menuTabs = occasionalTabs.filter((value) => value !== tab && permitted(value));
  const openTab = (value: TabValue) => setParams(value === 'overview' ? {} : { tab: value }, { replace: true });
  const tabEdges = useScrollEdges(tabs, 'x', `${tabScope}:${tab}:${isPending}:${Boolean(error)}:${mergedIntoId}`);
  // The sections rise after the profile card, once the record has loaded.
  useReveal(tabs as React.RefObject<HTMLElement | null>, 'item', Boolean(data));

  // A highlight tile opened a tab: the tile has gone with the overview, so focus moves to the tab it opened (WCAG 2.4.3).
  const focusTab = (location.state as { focusTab?: boolean } | null)?.focusTab === true;
  // By value, not aria-selected: Fluent marks the newly selected tab one render later than this effect runs.
  useEffect(() => {
    if (!focusTab) return;
    // Compared, not put into a selector: the value comes from the address.
    [...(tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((el) => el.getAttribute('value') === tab)?.focus();
  }, [focusTab, location.key, tab, tabs]);

  useEffect(() => {
    if (requestedTab !== 'service') return;
    const next = new URLSearchParams(params); next.set('tab', 'drift');
    setParams(next, { replace: true, state: location.state });
  }, [requestedTab, params, setParams, location.state]);

  useEffect(() => {
    if (mergedIntoId) {
      notify(t('duplicates.redirected'), 'info');
      navigate(`/organizations/${mergedIntoId}`, { replace: true });
    }
  }, [mergedIntoId, navigate, notify, t]);

  if (isPending || mergedIntoId) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const organization = data.data;
  const etag = data.etag;
  const city = organization.visitAddress?.city ?? organization.postalAddress?.city ?? null;

  const onDelete = async () => {
    await remove.mutateAsync(organization.id);
    notify(t('organizations.delete.done'));
    navigate('/organizations');
  };

  return (
    <>
      <ProfileHeader
        back={{ to: '/organizations', label: t('organizations.title') }}
        title={organization.name}
        section={tab === 'overview' ? undefined : t(`organizations.tabs.${tab}`)}
        pills={
          <>
            <OrganizationStatusBadge status={organization.status} />
            <RegistryStatusBadge status={organization.registryStatus} checkedAt={organization.registryCheckedAt} />
          </>
        }
        meta={[
          organization.orgNumber && <Text className={styles.orgNumber}>{formatOrgNumber(organization.orgNumber)}</Text>,
          city && <span>{city}</span>,
          organization.accountManager && (
            <span>
              {t('organizations.fields.accountManager')} <span className={styles.strong}>{organization.accountManager.displayName}</span>
            </span>
          ),
        ]}
        actions={
          <>
            {canEdit && (
              <Button icon={<Edit20Regular />} onClick={() => navigate(`/organizations/${organization.id}/edit`)}>
                {t('common.edit')}
              </Button>
            )}
            {/* A rare, destructive action is one step away from the everyday ones, not beside Edit (it still asks first). */}
            {canDelete && (
              <Menu positioning="below-end">
                <MenuTrigger disableButtonEnhancement>
                  <Button {...restoreFocusTarget} icon={<MoreHorizontal20Regular />} aria-label={t('organizations.moreActions')} />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<Delete20Regular />} onClick={() => setConfirmOpen(true)}>{t('organizations.delete.confirm')}</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
          </>
        }
      />

      {/* Only for someone who can merge (customers.delete): a warning a reader can neither act on nor dismiss is noise.
          Two names and a count, not a list that fills a phone screen. */}
      {canDelete && duplicates.data && duplicates.data.items.length > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('duplicates.banner', {
              name: [duplicates.data.items.slice(0, 2).map((p) => (p.first.id === organization.id ? p.second.name : p.first.name)).join(', '),
                duplicates.data.items.length > 2 ? t('duplicates.andMore', { count: duplicates.data.items.length - 2 }) : null].filter(Boolean).join(' '),
            })}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => navigate(`/organizations/duplicates?organizationId=${organization.id}`)}>
              {t('duplicates.bannerMore')}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      <TabList
        ref={tabs}
        className={styles.tabs}
        style={tabEdges.style}
        aria-label={t('organizations.tabsLabel')}
        selectedValue={tab}
        onTabSelect={(_, d) => { if (d.value !== MORE) openTab(d.value as TabValue); }}
      >
        {rowTabs.map((value) => <Tab key={value} value={value}>{t(`organizations.tabs.${value}`)}</Tab>)}
        {menuTabs.length > 0 && (
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Tab value={MORE} aria-label={t('organizations.tabs.moreNamed', { count: menuTabs.length })}>
                <span className={styles.more}>{t('organizations.tabs.more')}<ChevronDown16Regular aria-hidden /></span>
              </Tab>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {menuTabs.map((value) => <MenuItem key={value} onClick={() => openTab(value)}>{t(`organizations.tabs.${value}`)}</MenuItem>)}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </TabList>

      {tab === 'overview' && <Overview organization={organization} etag={etag} />}
      {tab === 'contacts' && <ContactsTab organizationId={organization.id} organizationName={organization.name} />}
      {tab === 'contracts' && canContracts && <OrganizationContractsTab organizationId={organization.id} />}
      {tab === 'drift' && canService && <OperationsTab organizationId={organization.id} />}
      {/* M42: the customer's Microsoft 365 backups at CloudAlly, one step away under "More" until it is opened. */}
      {tab === 'backup' && canService && <BackupTab organizationId={organization.id} />}
      {tab === 'deals' && canSales && <OrganizationDealsTab organizationId={organization.id} organizationName={organization.name} />}
      {tab === 'licenses' && canLicensing && <OrganizationLicensesTab organizationId={organization.id} />}
      {tab === 'projects' && canProjects && <OrganizationProjectsTab organizationId={organization.id} organizationName={organization.name} />}
      {tab === 'invoices' && canBilling && <OrganizationInvoicesTab organizationId={organization.id} />}
      {tab === 'activities' && canActivities && <ActivityTimeline organizationId={organization.id}
        selection={activitySelection(params)} navigationKey={location.key} onShowAll={() => {
          const next = new URLSearchParams(params); next.delete('activityId'); next.set('tab', 'activities');
          setParams(next, { replace: true });
        }} />}
      {tab === 'mail' && canActivities && <OrganizationMailTab organizationId={organization.id} />}
      {tab === 'documents' && <OrganizationDocumentsTab organizationId={organization.id} />}
      {tab === 'history' && <HistoryList module="customers" entityType="Organization" entityId={organization.id} />}

      <Dialog open={confirmOpen} onOpenChange={(_, d) => setConfirmOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('organizations.delete.title', { name: organization.name })}</DialogTitle>
            <DialogContent>
              {t('organizations.delete.body')}
              {remove.error && <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 8 }}>{errorMessage(remove.error, t)}</Text>}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
              <Button appearance="primary" onClick={() => void onDelete()} disabled={remove.isPending}>
                {t('organizations.delete.confirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/** One section of the records card: a region named by its heading, like the cards it replaces. */
function RecordSection({ title, icon, children }: { title: string; icon: React.ReactElement; children: React.ReactNode }) {
  const styles = useStyles();
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        <span aria-hidden style={{ display: 'inline-flex' }}>{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The filled facts of a section as a list; the empty ones as one line that names them, so the gap reads as a to-do. */
function RecordFacts({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const locale = localeOf(i18n.language);
  const filled = items.filter((item) => item.value);
  // Field names inside a sentence: lower case ("e-post, telefon og nettside"), but never an abbreviation ("NACE …").
  const missing = items.filter((item) => !item.value).map(({ label }) =>
    /^\p{Lu}\p{Lu}/u.test(label) ? label : label.charAt(0).toLocaleLowerCase(locale) + label.slice(1));
  return (
    <div className={styles.recordFacts}>
      {filled.length > 0 && <DetailList className={styles.facts} items={filled} />}
      {missing.length > 0 && (
        <Text block className={styles.missing}>
          {t('organizations.missing', { list: new Intl.ListFormat(locale, { type: 'conjunction' }).format(missing) })}
        </Text>
      )}
    </div>
  );
}

function Overview({ organization: o, etag }: { organization: Organization; etag: string | null }) {
  const styles = useStyles();
  const { t } = useTranslation();
  // Who to call first: the primary contact and their number, on the first screen (the contacts tab reads the same list).
  const contacts = useOrganizationContacts(o.id, false);
  const primary = contacts.data?.find((contact) => contact.isPrimary);
  const primaryPhone = primary ? primary.mobilePhone ?? primary.phone : null;
  const f = (key: string) => t(`organizations.fields.${key}`);
  const records = useRef<HTMLDivElement>(null);
  useReveal(records, 'card');

  return (
    <>
    <CustomerHighlights organizationId={o.id} />
    <div className={styles.stack}>
      <div ref={records} className={styles.records}>
      <RecordSection title={t('organizations.sections.contactInfo')} icon={<ContactCard16Regular />}>
        <RecordFacts
          items={[
            { label: t('organizations.primaryContact'), value: primary && <span className={styles.domains}>
              <AppLink to={`/contacts/${primary.contactId}`}>{`${primary.firstName} ${primary.lastName}`.trim()}</AppLink>
              {primaryPhone && <> · <Link href={`tel:${primaryPhone.replace(/\s/g, '')}`}>{primaryPhone}</Link></>}
              {primary.email && <> · <Link href={`mailto:${primary.email}`}>{primary.email}</Link></>}
            </span> },
            { label: f('email'), value: o.email && <Link href={`mailto:${o.email}`}>{o.email}</Link> },
            { label: f('phone'), value: o.phone && <Link href={`tel:${o.phone.replace(/\s/g, '')}`}>{o.phone}</Link> },
            { label: f('website'), value: o.website && <Link href={safeHttpUrl(o.website)} target="_blank" rel="noopener noreferrer">{o.website}</Link> },
            { label: f('domains'), value: o.domains.length > 0 && <span className={styles.domains}>{o.domains.join(', ')}</span> },
          ]}
        />
      </RecordSection>
      <RecordSection title={t('organizations.sections.company')} icon={<Building16Regular />}>
        <RecordFacts
          items={[
            { label: f('orgNumber'), value: formatOrgNumber(o.orgNumber) },
            { label: f('legalForm'), value: o.legalForm },
            { label: f('naceCode'), value: o.naceCode },
            { label: t('organizations.columns.registry'), value: o.registryCheckedAt && `${t(`registry.${o.registryStatus}`)} · ${formatDate(o.registryCheckedAt)}` },
          ]}
        />
      </RecordSection>
      <RecordSection title={t('organizations.sections.responsibility')} icon={<Person16Regular />}>
        <RecordFacts
          items={[
            { label: f('accountManager'), value: o.accountManager?.displayName },
            { label: f('primaryTechnician'), value: o.primaryTechnician?.displayName },
          ]}
        />
      </RecordSection>
      <RecordSection title={t('organizations.sections.addresses')} icon={<Location16Regular />}>
        <RecordFacts
          items={[
            { label: f('visitAddress'), value: formatAddress(o.visitAddress) },
            { label: f('postalAddress'), value: formatAddress(o.postalAddress) },
            { label: f('billingAddress'), value: formatAddress(o.billingAddress) },
          ]}
        />
      </RecordSection>
      <RecordSection title={t('organizations.sections.invoicing')} icon={<Receipt16Regular />}>
        <RecordFacts
          items={[
            { label: f('invoiceEmail'), value: o.invoiceEmail },
            { label: f('ehfEnabled'), value: o.ehfEnabled ? t('common.yes') : t('common.no') },
          ]}
        />
      </RecordSection>
      <RecordSection title={t('organizations.sections.record')} icon={<Clock16Regular />}>
        <DetailList
          className={styles.facts}
          items={[
            { label: f('createdAt'), value: formatDateTime(o.createdAt) },
            { label: f('modifiedAt'), value: o.modifiedAt ? formatDateTime(o.modifiedAt) : t('organizations.notChangedYet') },
          ]}
        />
      </RecordSection>
      </div>
      <Panel title={t('organizations.sections.group')} icon={<PeopleTeam16Regular />}>
        <OrganizationGroupPanel organization={o} etag={etag} />
      </Panel>
      <LinkedSystemsPanel entityId={o.id} />
      <CustomFieldsPanel framed entity="Organization" entityId={o.id} />
    </div>
    </>
  );
}
