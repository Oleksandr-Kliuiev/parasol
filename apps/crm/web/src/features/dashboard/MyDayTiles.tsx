import { AlertUrgent20Regular, Clock20Regular, CalendarClock20Regular, Receipt20Regular, TaskListSquareLtr20Regular, Warning20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { PagedResult } from '../../api/types';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { KpiRow, KpiTile } from '../../shared/components/KpiTile';
import { formatMoney, formatNumber, todayIso } from '../../shared/utils/format';
import { addDays, startOfWeek } from '../../shared/utils/week';
import { useCachedQueryData } from '../../shared/utils/useCachedQueryData';
import type { Activity } from '../activities/types';
import { useInvoices } from '../billing/api';
import { useReminders } from '../contracts/api';
import { useAllTimeEntries } from '../time/api';
import type { MyDayProfile } from './myDayProfile';
import { alertsFreshness } from '../service/alerts/alertReads';
import { useUrgentAlertsAnswer } from './urgentAlerts';

type Tile = 'alerts' | 'tasks' | 'hours' | 'reminders' | 'overdue' | 'registry';

const order: Record<MyDayProfile, readonly Tile[]> = {
  work: ['alerts', 'tasks', 'hours', 'reminders', 'registry'],
  lead: ['alerts', 'tasks', 'hours', 'reminders', 'registry'],
  finance: ['overdue', 'alerts', 'reminders', 'hours', 'registry'],
};

/**
 * Four key figures above the panels. The alert and task figures read the panels' own query results from the cache (the
 * panels own the request, its refresh and its errors), so the tiles add no reads and never show a number the panel does not.
 */
export function MyDayTiles({ profile, organizations, warnings }: { profile: MyDayProfile; organizations: number; warnings: number }) {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  const canAlerts = useCan(Permissions.serviceRead);
  const canTasks = useCan(Permissions.activitiesRead);
  const canTime = useCan(Permissions.timeOwn);
  const canContracts = useCan(Permissions.contractsRead);
  const canBilling = useCan(Permissions.billingRead);
  const canMoney = useCan(Permissions.financeRead);
  const monday = startOfWeek(todayIso());

  const alerts = useUrgentAlertsAnswer(user.id, permissionsKey);
  const tasks = useCachedQueryData<{ page: PagedResult<Activity> }>(['activities', 'personal', user.id, permissionsKey]);
  const week = useAllTimeEntries({ from: monday, to: addDays(monday, 6), mine: true }, canTime);
  const reminders = useReminders({ mine: true }, canContracts);
  const overdue = useInvoices({ overdueOnly: true, limit: 1 }, canBilling);

  const pending = t('myDay.loadingValue');
  // Zero critical alerts means something only once a source has been read; until then, and after a failed read, the tile says so.
  const alertsRead = alerts.data ? alertsFreshness(alerts.data.reads) : null;
  const alertsEnded = alerts.failed ? 'myDay.kpi.alertsFailed' : alertsRead === 'notRead' ? 'myDay.kpi.alertsNotRead' : null;
  const tiles: Record<Tile, React.ReactNode> = {
    alerts: canAlerts && (
      <KpiTile
        key="alerts"
        icon={<AlertUrgent20Regular />}
        label={t('myDay.kpi.alerts')}
        value={alertsEnded ? '—' : alerts.data ? formatNumber(alerts.data.critical) : pending}
        foot={alertsEnded ? t(alertsEnded) : alerts.data
          ? t(alertsRead === 'incomplete' ? 'myDay.kpi.alertsFootIncomplete' : alertsRead === 'late' ? 'myDay.kpi.alertsFootLate' : 'myDay.kpi.alertsFoot',
            { count: alerts.data.warning })
          : pending}
        to="?section=alerts#my-day-alerts"
      />
    ),
    tasks: canTasks && (
      <KpiTile
        key="tasks"
        tone="iris"
        icon={<TaskListSquareLtr20Regular />}
        label={t('myDay.kpi.tasks')}
        value={tasks ? formatNumber(tasks.page.totalCount) : pending}
        foot={t('myDay.kpi.tasksFoot')}
        to="?section=tasks#my-day-tasks"
      />
    ),
    hours: canTime && (
      <KpiTile
        key="hours"
        tone="spruce"
        icon={<Clock20Regular />}
        label={t('myDay.kpi.hours')}
        value={week.data ? t('myDay.kpi.hoursValue', { hours: formatNumber(week.data.summary.hours) }) : pending}
        foot={week.data ? t('myDay.kpi.hoursFoot', { billable: formatNumber(week.data.summary.billableHours), fresh: formatNumber(week.data.summary.newHours) }) : pending}
        to="/time"
      />
    ),
    reminders: canContracts && (
      <KpiTile
        key="reminders"
        tone="saffron"
        icon={<CalendarClock20Regular />}
        label={t('myDay.kpi.reminders')}
        value={reminders.total !== null ? formatNumber(reminders.total) : pending}
        foot={t('myDay.kpi.remindersFoot')}
        to="/contracts"
      />
    ),
    overdue: canBilling && (
      <KpiTile
        key="overdue"
        icon={<Receipt20Regular />}
        label={t('myDay.kpi.overdue')}
        value={overdue.data ? formatNumber(overdue.data.count) : pending}
        foot={overdue.data && canMoney ? t('myDay.kpi.overdueFoot', { amount: formatMoney(overdue.data.overdue) }) : t('myDay.kpi.overdueOpen')}
        to="/billing/invoices?overdue=true"
      />
    ),
    registry: (
      <KpiTile
        key="registry"
        tone="neutral"
        icon={<Warning20Regular />}
        label={t('myDay.kpi.registry')}
        value={formatNumber(warnings)}
        foot={t('myDay.kpi.registryFoot', { count: organizations })}
      />
    ),
  };
  const shown = order[profile].map((name) => tiles[name]).filter(Boolean).slice(0, 4);
  if (shown.length === 0) return null;
  return <KpiRow label={t('myDay.kpiLabel')}>{shown}</KpiRow>;
}
