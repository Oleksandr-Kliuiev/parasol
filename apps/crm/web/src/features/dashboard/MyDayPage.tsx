import { Fragment, useState, type ReactNode } from 'react';
import { Avatar, Button, Skeleton, SkeletonItem, Text, makeStyles, mergeClasses, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import {
  Add20Regular, Building16Regular, Building24Regular, CalendarLtr16Regular, ShieldCheckmark24Regular, Warning16Regular, Warning20Filled,
} from '@fluentui/react-icons';
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
import { TimeEntryDialogHost } from '../time/TimeEntryDialog';
import { todayIso } from '../../shared/utils/format';
import { AtlasAttentionPanel } from '../parasol/AtlasAttentionPanel';
import { MyDaySection, MyDaySectionLinks } from './MyDaySections';
import { MyDayTiles } from './MyDayTiles';
import { h } from '../../app/hearth';
import { BillingPanel, HoursReviewPanel, LicensingAttentionPanel, StaleDealsPanel } from './MyDayPanels';
import { useMyDayStyles } from './myDayStyles';
import { useMediaQuery } from '../../shared/utils/useMediaQuery';
import { mainOrder, myDayProfile, sideOrder, type MainSection, type SideSection } from './myDayProfile';

/** Where the page grid has two columns (see `grid`). */
const WIDE_MY_DAY = '(min-width: 1101px)';

const useStyles = makeStyles({
  // The side column holds the personal list beside the technical one, so it is wider than a column of notes.
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.75fr) minmax(320px, 1fr)',
    gap: '16px',
    alignItems: 'start',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  // On tablets the side panels sit in two columns under the main ones instead of one long column.
  aside: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minWidth: 0,
    '@media (max-width: 1100px) and (min-width: 700px)': { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'start' },
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginInlineStart: 'auto' },
  org: { display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: '1 1 220px' },
  date: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    height: '42px',
    boxSizing: 'border-box',
    paddingInline: '14px',
    borderRadius: '12px',
    border: `1px solid ${h.line2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: h.muted,
    fontSize: '13px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    '@media (max-width: 560px)': { display: 'none' },
  },
});

export function MyDayPage() {
  const styles = useStyles();
  const shared = useMyDayStyles();
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const canContracts = useCan(Permissions.contractsRead);
  const canActivities = useCan(Permissions.activitiesRead);
  const canCustomers = useCan(Permissions.customersRead);
  const canAtlas = useCan(Permissions.parasolAtlasRead);
  const canAttention = canCustomers && canAtlas;
  const canSales = useCan(Permissions.salesRead);
  const canLicensing = useCan(Permissions.licensingRead);
  const canBilling = useCan(Permissions.billingRead);
  const canApproveHours = useCan(Permissions.timeManage);
  const canRegisterHours = useCan(Permissions.timeOwn);
  // The day's most frequent entry, as the reference puts its main action in the page header.
  const [registering, setRegistering] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const profile = myDayProfile(user.permissions);
  // One screen in the morning (UX concept §3): on a wide screen the short personal task list stands beside the long
  // technical list instead of under it; one column keeps attention, then tasks. The DOM follows what is shown, so the
  // reading and focus order is the visual order at every width.
  const wide = useMediaQuery(WIDE_MY_DAY);
  const mainSections = wide ? mainOrder[profile].filter((name) => name !== 'tasks') : mainOrder[profile];
  const { data, error, isPending, refetch } = useOrganizations({ accountManagerId: user.id, limit: 200 });
  const organizations = data?.pages.flatMap((p) => p.items) ?? [];
  const warnings = organizations.filter((o) => registryWarningStatuses.includes(o.registryStatus));
  const firstName = user.displayName.split(' ')[0];
  const now = new Date();
  const today = new Intl.DateTimeFormat(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' }).format(now);
  // The greeting follows the hour in Oslo, like the date beside it.
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(now));
  const partOfDay = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';

  const main: Record<MainSection, ReactNode> = {
    attention: canAttention && <MyDaySection name="attention"><AtlasAttentionPanel /></MyDaySection>,
    tasks: canActivities && <MyDaySection name="tasks"><MyTasksPanel /></MyDaySection>,
    deals: canSales && <StaleDealsPanel />,
    licensing: canLicensing && <LicensingAttentionPanel />,
    billing: canBilling && <BillingPanel />,
    organizations: (
      <Panel title={t('myDay.myOrganizations')} icon={<Building16Regular />}>
        {isPending && (
          <Skeleton aria-label={t('common.loading')}>
            <SkeletonItem />
            <SkeletonItem />
            <SkeletonItem />
          </Skeleton>
        )}
        {error && <ErrorState error={error} onRetry={() => void refetch()} />}
        {!isPending && !error && organizations.length === 0 && <EmptyState compact icon={<Building24Regular />} message={t('myDay.myOrganizationsEmpty')} />}
        <ul className={mergeClasses(shared.list, 'h-stagger')}>
          {organizations.map((o) => (
            <li key={o.id} className={shared.row}>
              <div className={styles.org}>
                <Avatar name={o.name} size={36} color="colorful" aria-hidden />
                <div className={shared.rowText}>
                  <AppLink to={`/organizations/${o.id}`}>
                    <Text weight="semibold">{o.name}</Text>
                  </AppLink>
                  <Text size={200} className={shared.muted}>
                    {[formatOrgNumber(o.orgNumber), o.city].filter(Boolean).join(' · ')}
                  </Text>
                </div>
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
      <Panel title={t('myDay.registryWarnings')} icon={<Warning16Regular />}>
        {warnings.length === 0 ? (
          <EmptyState compact icon={<ShieldCheckmark24Regular />} message={t('myDay.registryWarningsEmpty')} />
        ) : (
          <ul className={mergeClasses(shared.list, 'h-stagger')}>
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
    // "New organization" moved to the New menu of the top bar, where every page has it.
    quick: null,
  };

  const subtitle = profile === 'lead' ? t('myDay.subtitleLead') : profile === 'finance' ? t('myDay.subtitleFinance') : t('myDay.subtitle');

  return (
    <>
      <PageHeader
        title={t(`myDay.greeting.${partOfDay}`, { name: firstName })}
        documentTitle={t('nav.myDay')}
        subtitle={subtitle}
        actions={
          <>
            <span className={styles.date}>
              <CalendarLtr16Regular aria-hidden />
              {today}
            </span>
            {canRegisterHours && (
              <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setRegistering(true)}>
                {t('time.register')}
              </Button>
            )}
          </>
        }
      />
      {canRegisterHours && (
        <TimeEntryDialogHost open={registering} defaultDate={todayIso()} onClose={() => setRegistering(false)} />
      )}
      <MyDayTiles profile={profile} organizations={organizations.length} warnings={warnings.length} />
      <MyDaySectionLinks tasks={canActivities} attention={canAttention} />
      <div className={styles.grid}>
        <div className={styles.side}>
          {mainSections.map((name) => <Fragment key={name}>{main[name]}</Fragment>)}
        </div>
        <div className={styles.aside}>
          {wide && main.tasks}
          {sideOrder[profile].map((name) => <Fragment key={name}>{side[name]}</Fragment>)}
        </div>
      </div>
    </>
  );
}
