import { Fragment, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, Skeleton, SkeletonItem, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular, Warning20Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { registryWarningStatuses } from '../../shared/utils/registry';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useOrganizations } from '../organizations/api';
import { RemindersPanel } from '../contracts/RemindersPanel';
import { MyTasksPanel } from '../activities/MyTasksPanel';
import { AtlasAttentionPanel } from '../parasol/AtlasAttentionPanel';
import { MyDaySection, MyDaySectionLinks } from './MyDaySections';
import { BillingPanel, HoursReviewPanel, LicensingAttentionPanel, StaleDealsPanel } from './MyDayPanels';
import { useMyDayStyles } from './myDayStyles';
import { mainOrder, myDayProfile, sideOrder, type MainSection, type SideSection } from './myDayProfile';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS },
});

export function MyDayPage() {
  const styles = useStyles();
  const shared = useMyDayStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const canCreate = useCan(Permissions.customersWrite);
  const canContracts = useCan(Permissions.contractsRead);
  const canActivities = useCan(Permissions.activitiesRead);
  const canCustomers = useCan(Permissions.customersRead);
  const canAtlas = useCan(Permissions.parasolAtlasRead);
  const canAttention = canCustomers && canAtlas;
  const canSales = useCan(Permissions.salesRead);
  const canLicensing = useCan(Permissions.licensingRead);
  const canBilling = useCan(Permissions.billingRead);
  const canApproveHours = useCan(Permissions.timeManage);
  const profile = myDayProfile(user.permissions);
  const { data, error, isPending, refetch } = useOrganizations({ accountManagerId: user.id, limit: 200 });
  const organizations = data?.pages.flatMap((p) => p.items) ?? [];
  const warnings = organizations.filter((o) => registryWarningStatuses.includes(o.registryStatus));
  const firstName = user.displayName.split(' ')[0];

  const main: Record<MainSection, ReactNode> = {
    attention: canAttention && <MyDaySection name="attention"><AtlasAttentionPanel /></MyDaySection>,
    tasks: canActivities && <MyDaySection name="tasks"><MyTasksPanel /></MyDaySection>,
    deals: canSales && <StaleDealsPanel />,
    licensing: canLicensing && <LicensingAttentionPanel />,
    billing: canBilling && <BillingPanel />,
    organizations: (
      <Panel title={t('myDay.myOrganizations')}>
        {isPending && (
          <Skeleton aria-label={t('common.loading')}>
            <SkeletonItem />
            <SkeletonItem />
            <SkeletonItem />
          </Skeleton>
        )}
        {error && <ErrorState error={error} onRetry={() => void refetch()} />}
        {!isPending && !error && organizations.length === 0 && <EmptyState message={t('myDay.myOrganizationsEmpty')} />}
        <ul className={shared.list}>
          {organizations.map((o) => (
            <li key={o.id} className={shared.row}>
              <div className={shared.rowText}>
                <AppLink to={`/organizations/${o.id}`}>
                  <Text weight="semibold">{o.name}</Text>
                </AppLink>
                <Text size={200} className={shared.muted}>
                  {[formatOrgNumber(o.orgNumber), o.city].filter(Boolean).join(' · ')}
                </Text>
              </div>
              <span className={styles.badges}>
                <RegistryStatusBadge status={o.registryStatus} />
                <OrganizationStatusBadge status={o.status} />
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    ),
  };

  const side: Record<SideSection, ReactNode> = {
    hours: canApproveHours && <HoursReviewPanel />,
    reminders: canContracts && <RemindersPanel />,
    registry: (
      <Panel title={t('myDay.registryWarnings')}>
        {warnings.length === 0 ? (
          <Text className={shared.muted}>{t('myDay.registryWarningsEmpty')}</Text>
        ) : (
          <ul className={shared.list}>
            {warnings.map((o) => (
              <li key={o.id} className={shared.row}>
                <span className={shared.warning}>
                  <Warning20Filled aria-hidden />
                  <span>
                    <AppLink to={`/organizations/${o.id}`}>{o.name}</AppLink>
                    <Text block size={200}>
                      {t(`registry.${o.registryStatus}`)}
                    </Text>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    ),
    quick: canCreate && (
      <Panel title={t('myDay.quickActions')}>
        <Button icon={<Add20Regular />} onClick={() => navigate('/organizations/new')}>
          {t('myDay.newOrganization')}
        </Button>
      </Panel>
    ),
  };

  const subtitle = profile === 'lead' ? t('myDay.subtitleLead') : profile === 'finance' ? t('myDay.subtitleFinance') : t('myDay.subtitle');

  return (
    <>
      <PageHeader title={t('myDay.greeting', { name: firstName })} documentTitle={t('nav.myDay')} subtitle={subtitle} />
      <MyDaySectionLinks tasks={canActivities} attention={canAttention} />
      <div className={styles.grid}>
        <div className={styles.side}>
          {mainOrder[profile].map((name) => <Fragment key={name}>{main[name]}</Fragment>)}
        </div>
        <div className={styles.side}>
          {sideOrder[profile].map((name) => <Fragment key={name}>{side[name]}</Fragment>)}
        </div>
      </div>
    </>
  );
}
