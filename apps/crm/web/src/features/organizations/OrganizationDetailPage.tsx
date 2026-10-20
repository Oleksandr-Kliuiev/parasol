import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
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
import { Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { Organization } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { useNotify } from '../../shared/components/useNotify';
import { formatAddress, formatDate, formatDateTime } from '../../shared/utils/format';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { HistoryList } from '../audit/HistoryList';
import { ContactsTab } from '../contacts/ContactsTab';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useDeleteOrganization, useOrganization } from './api';
import { useDuplicates } from './duplicatesApi';
import { LinkedSystemsPanel } from '../integrations/LinkedSystemsPanel';
import { OrganizationContractsTab } from '../contracts/OrganizationContractsTab';
import { OrganizationServiceTab } from '../service/OrganizationServiceTab';
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
import { CustomerWorkspacePanel } from '../parasol/CustomerWorkspacePanel';
import { CustomerIdentityPanel } from '../parasol/CustomerIdentityPanel';
import { useCustomerTabVisibility } from './useCustomerTabVisibility';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';

const useStyles = makeStyles({
  // The tab bar scrolls sideways without widening a phone; URL-selected tabs are revealed too.
  tabs: { marginBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
  overview: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingHorizontalL, alignItems: 'start', minWidth: 0,
    '@media (min-width: 1100px)': { ':has([data-technical-layout])': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' } } },
  stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingHorizontalL, alignItems: 'start', minWidth: 0 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  orgNumber: { fontVariantNumeric: 'tabular-nums', color: tokens.colorNeutralForeground3 },
  domains: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
});

type TabValue =
  | 'overview'
  | 'contacts'
  | 'contracts'
  | 'service'
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
  const tab = (params.get('tab') as TabValue | null) ?? 'overview';
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
  const tabEdges = useScrollEdges(tabs, 'x', `${tabScope}:${tab}:${isPending}:${Boolean(error)}:${mergedIntoId}`);

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

  const onDelete = async () => {
    await remove.mutateAsync(organization.id);
    notify(t('organizations.delete.done'));
    navigate('/organizations');
  };

  return (
    <>
      <PageHeader
        back={{ to: '/organizations', label: t('organizations.title') }}
        title={organization.name}
        meta={
          <>
            {organization.orgNumber && <Text className={styles.orgNumber}>{formatOrgNumber(organization.orgNumber)}</Text>}
            <OrganizationStatusBadge status={organization.status} />
            <RegistryStatusBadge status={organization.registryStatus} checkedAt={organization.registryCheckedAt} />
          </>
        }
        actions={
          <>
            {canEdit && (
              <Button icon={<Edit20Regular />} onClick={() => navigate(`/organizations/${organization.id}/edit`)}>
                {t('common.edit')}
              </Button>
            )}
            {canDelete && (
              <Button {...restoreFocusTarget} icon={<Delete20Regular />} appearance="subtle" onClick={() => setConfirmOpen(true)}>
                {t('common.delete')}
              </Button>
            )}
          </>
        }
      />

      {duplicates.data && duplicates.data.items.length > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('duplicates.banner', {
              name: duplicates.data.items.map((p) => (p.first.id === organization.id ? p.second.name : p.first.name)).join(', '),
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
        onTabSelect={(_, d) => setParams(d.value === 'overview' ? {} : { tab: String(d.value) }, { replace: true })}
      >
        <Tab value="overview">{t('organizations.tabs.overview')}</Tab>
        <Tab value="contacts">{t('organizations.tabs.contacts')}</Tab>
        {canContracts && <Tab value="contracts">{t('organizations.tabs.contracts')}</Tab>}
        {canService && <Tab value="service">{t('organizations.tabs.service')}</Tab>}
        {canSales && <Tab value="deals">{t('organizations.tabs.deals')}</Tab>}
        {canLicensing && <Tab value="licenses">{t('organizations.tabs.licenses')}</Tab>}
        {canProjects && <Tab value="projects">{t('organizations.tabs.projects')}</Tab>}
        {canBilling && <Tab value="invoices">{t('organizations.tabs.invoices')}</Tab>}
        {canActivities && <Tab value="activities">{t('organizations.tabs.activities')}</Tab>}
        {canActivities && <Tab value="mail">{t('organizations.tabs.mail')}</Tab>}
        <Tab value="documents">{t('organizations.tabs.documents')}</Tab>
        <Tab value="history">{t('organizations.tabs.history')}</Tab>
      </TabList>

      {tab === 'overview' && <Overview organization={organization} etag={etag} />}
      {tab === 'contacts' && <ContactsTab organizationId={organization.id} organizationName={organization.name} />}
      {tab === 'contracts' && canContracts && <OrganizationContractsTab organizationId={organization.id} />}
      {tab === 'service' && canService && <OrganizationServiceTab organizationId={organization.id} />}
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

function Overview({ organization: o, etag }: { organization: Organization; etag: string | null }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const technical = useCan(Permissions.parasolAtlasRead);
  const f = (key: string) => t(`organizations.fields.${key}`);

  return (
    <div className={technical ? styles.overview : styles.stack}>
      <div className={technical ? styles.stack : styles.grid}>
        <CustomerWorkspacePanel customerId={o.id} />
        <CustomerIdentityPanel customerId={o.id} />
      </div>
      <div className={styles.grid}>
      <Panel title={t('organizations.sections.contactInfo')}>
        <DetailList
          items={[
            { label: f('email'), value: o.email && <Link href={`mailto:${o.email}`}>{o.email}</Link> },
            { label: f('phone'), value: o.phone && <Link href={`tel:${o.phone.replace(/\s/g, '')}`}>{o.phone}</Link> },
            { label: f('website'), value: o.website && <Link href={safeHttpUrl(o.website)} target="_blank" rel="noopener noreferrer">{o.website}</Link> },
            { label: f('domains'), value: o.domains.length > 0 && <span className={styles.domains}>{o.domains.join(', ')}</span> },
          ]}
        />
      </Panel>
      <Panel title={t('organizations.sections.company')}>
        <DetailList
          items={[
            { label: f('orgNumber'), value: formatOrgNumber(o.orgNumber) },
            { label: f('legalForm'), value: o.legalForm },
            { label: f('naceCode'), value: o.naceCode },
            { label: t('organizations.columns.registry'), value: o.registryCheckedAt && `${t(`registry.${o.registryStatus}`)} · ${formatDate(o.registryCheckedAt)}` },
          ]}
        />
      </Panel>
      <Panel title={t('organizations.sections.responsibility')}>
        <DetailList
          items={[
            { label: f('accountManager'), value: o.accountManager?.displayName },
            { label: f('primaryTechnician'), value: o.primaryTechnician?.displayName },
          ]}
        />
      </Panel>
      <Panel title={t('organizations.sections.addresses')}>
        <DetailList
          items={[
            { label: f('visitAddress'), value: formatAddress(o.visitAddress) },
            { label: f('postalAddress'), value: formatAddress(o.postalAddress) },
            { label: f('billingAddress'), value: formatAddress(o.billingAddress) },
          ]}
        />
      </Panel>
      <Panel title={t('organizations.sections.invoicing')}>
        <DetailList
          items={[
            { label: f('invoiceEmail'), value: o.invoiceEmail },
            { label: f('ehfEnabled'), value: o.ehfEnabled ? t('common.yes') : t('common.no') },
          ]}
        />
      </Panel>
      <Panel title={t('customFields.panelTitle')}>
        <CustomFieldsPanel entity="Organization" entityId={o.id} />
      </Panel>
      <Panel title={t('organizations.sections.group')}>
        <OrganizationGroupPanel organization={o} etag={etag} />
      </Panel>
      <LinkedSystemsPanel entityId={o.id} />
      <Panel title={t('organizations.sections.record')}>
        <DetailList
          items={[
            { label: f('createdAt'), value: formatDateTime(o.createdAt) },
            { label: f('modifiedAt'), value: formatDateTime(o.modifiedAt) },
          ]}
        />
      </Panel>
      </div>
    </div>
  );
}
