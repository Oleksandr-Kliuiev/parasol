import { Clock20Regular, CalendarClock20Regular, Receipt20Regular, TaskListSquareLtr20Regular, Warning20Regular } from '@fluentui/react-icons';
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

type Tile = 'tasks' | 'hours' | 'reminders' | 'overdue' | 'registry';

const order: Record<MyDayProfile, readonly Tile[]> = {
  work: ['tasks', 'hours', 'reminders', 'registry'],
  lead: ['tasks', 'hours', 'reminders', 'registry'],
  finance: ['overdue', 'reminders', 'hours', 'registry'],
};

/**
 * Four key figures above the panels. The task figure reads the panel's own query result from the cache (the panel owns
 * the request, its refresh and its errors), so the tile adds no read and never shows a number the panel does not.
 */
export function MyDayTiles({ profile, organizations, warnings }: { profile: MyDayProfile; organizations: number; warnings: number }) {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  const canTasks = useCan(Permissions.activitiesRead);
  const canTime = useCan(Permissions.timeOwn);
  const canContracts = useCan(Permissions.contractsRead);
  const canBilling = useCan(Permissions.billingRead);
  const canMoney = useCan(Permissions.financeRead);
  const monday = startOfWeek(todayIso());

  const tasks = useCachedQueryData<{ page: PagedResult<Activity> }>(['activities', 'personal', user.id, permissionsKey]);
  const week = useAllTimeEntries({ from: monday, to: addDays(monday, 6), mine: true }, canTime);
  const reminders = useReminders({ mine: true }, canContracts);
  const overdue = useInvoices({ overdueOnly: true, limit: 1 }, canBilling);

  const pending = t('myDay.loadingValue');
  const tiles: Record<Tile, React.ReactNode> = {
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
