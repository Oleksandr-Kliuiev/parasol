import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, DialogSurface, Dropdown, Option, Spinner, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  CalendarLtr16Regular,
  CheckmarkCircle16Regular,
  CheckmarkCircle20Regular,
  Clock16Regular,
  Clock24Regular,
  Hourglass16Regular,
  LockClosed16Regular,
  LockClosed20Regular,
  LockOpen20Regular,
  Money16Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { usePeriods, useTimeActions, useTimeEntries } from './api';
import { ClosePeriodDialog } from './ClosePeriodDialog';
import { financialReviewPermissions } from './financialReviewAccess';
import { monthName } from './monthName';
import { AdjustDialog, ReopenDialog } from './TimeEntryReviewDialogs';
import { TimeEntriesTable } from './TimeEntriesTable';
import { actionable, statusDot } from './timeEntryState';
import { TimePeriodsPanel } from './TimePeriodsPanel';
import { timeStatuses, type Period, type TimeEntry, type TimeEntryStatus } from './types';

const useStyles = makeStyles({
  // Four figures of the month in one row; two by two on a phone.
  stats: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))', '@media (max-width: 560px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
  month: { minWidth: '200px' },
  // A card without a table keeps the card's own padding around its message.
  body: { paddingLeft: '20px', paddingRight: '20px', paddingBottom: '20px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px', paddingBottom: '16px' } },
  loading: { paddingTop: '24px', paddingBottom: '24px' },
});

/** Everyone's hours for a month: correct, approve and close the period (FR-TIM-03). */
export function TimeEntriesPage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const canManage = useCan(Permissions.timeManage);
  const user = useCurrentUser();
  const canReview = financialReviewPermissions.every(p => user.permissions.includes(p));
  const canSeeMoney = useCan(Permissions.financeRead);
  const canUnlock = useCan(Permissions.timeUnlock);
  const actions = useTimeActions();
  const [params, setParams] = useSearchParams();
  const now = new Date();
  const year = Number(params.get('year') ?? now.getFullYear());
  const month = Number(params.get('month') ?? now.getMonth() + 1);
  const reviewOnly = params.get('reviewOnly') === 'true';
  const status = (params.get('status') as TimeEntryStatus | null) ?? null;
  // The selection belongs to one month and filter: another month (a tile, Back) starts with none.
  const view = `${year}-${month}-${status ?? ''}-${reviewOnly}`;
  const [selection, setSelection] = useState<{ view: string; ids: string[] }>({ view, ids: [] });
  const selected = selection.view === view ? selection.ids : [];
  const setSelected = (ids: string[]) => setSelection({ view, ids });
  const [adjusting, setAdjusting] = useState<TimeEntry | null>(null);
  const [reopening, setReopening] = useState<Period | null>(null);
  const [closingPeriod, setClosingPeriod] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const shownEntry = useKeptWhileClosing(adjusting);
  const shownPeriod = useKeptWhileClosing(reopening);
  const restoreFocusTarget = useRestoreFocusTarget();

  const pages = useTimeEntries({ year, month, status, reviewOnly });
  // The summary of the newest answer covers every entry the filter matches, not only the rows loaded so far.
  const data = pages.latest;
  const { error, isPending, refetch } = pages;
  const periods = usePeriods(year);
  const period = periods.data?.find((p) => p.month === month);
  const closed = period?.isClosed === true;
  const entries = pages.items;
  // Approval and withdrawal are offered for what they can apply to: never in a closed month, never for billed work.
  // Each action counts and sends only the chosen entries it applies to, so "Approve (4)" approves four.
  const chosen = entries.filter((e) => selected.includes(e.id));
  const approvable = canManage && !closed ? chosen.filter((e) => e.status === 'New' && !e.isLocked).map((e) => e.id) : [];
  const withdrawable = canManage && !closed ? chosen.filter((e) => (e.status === 'Approved' || e.status === 'NonBillable') && !e.isLocked).map((e) => e.id) : [];
  const canApprove = approvable.length > 0;
  const canWithdraw = withdrawable.length > 0;
  const filtered = status !== null || reviewOnly;
  // While the month loads its figures show a placeholder, not a zero that would count up later.
  const hours = (value: number | undefined) => (value === undefined ? t('myDay.loadingValue') : `${formatNumber(value)} ${t('contracts.hoursShort')}`);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected([]);
  };

  const monthHref = (value: number) => {
    const next = new URLSearchParams(params);
    next.set('year', String(year));
    next.set('month', String(value));
    return `?${next.toString()}`;
  };

  // The bulk buttons go with the selection they act on; focus stays in the card instead of falling to the page.
  const settle = () => { setSelected([]); panelHeading.current?.focus(); };

  const withdraw = async () => {
    try {
      await actions.withdraw.mutateAsync(withdrawable);
      notify(t('time.withdrawn'));
      settle();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const approve = async () => {
    try {
      const result = await actions.approve.mutateAsync(approvable);
      // The server words its reasons in English; the person gets the count in their language and the rows show the state.
      notify(t('time.approved', { count: result.data.approved }), result.data.skipped > 0 ? 'warning' : 'success',
        result.data.skipped > 0 ? t('time.approveSkipped', { count: result.data.skipped }) : undefined);
      settle();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const closedBadge = closed && (
    <Badge appearance="tint" color="informative" icon={<LockClosed16Regular />}>
      {period?.closedAt && period.closedByName
        ? t('time.periodClosed', { at: formatDate(period.closedAt), by: period.closedByName })
        : t('time.closed')}
    </Badge>
  );

  return (
    <>
      <PageHeader title={t('time.title')} subtitle={t('time.subtitle')} />
      <Toolbar
        end={
          <FilterChips
            label={t('financialReview.savedOnly')}
            value={reviewOnly ? 'on' : ''}
            options={[{ value: 'on', label: t('financialReview.savedOnlyShort') }]}
            onChange={() => setParam('reviewOnly', reviewOnly ? null : 'true')}
          />
        }
      >
        <FilterField label={t('time.fields.period')}>
          <Dropdown
            className={styles.month}
            value={monthName(year, month, i18n.language)}
            selectedOptions={[`${year}-${month}`]}
            onOptionSelect={(_, d) => {
              const [y, m] = (d.optionValue ?? '').split('-');
              const next = new URLSearchParams(params);
              next.set('year', y!);
              next.set('month', m!);
              setParams(next, { replace: true });
              setSelected([]);
            }}
          >
            {[year, year - 1].flatMap((y) => Array.from({ length: 12 }, (_, i) => 12 - i).map((m) => (
              <Option key={`${y}-${m}`} value={`${y}-${m}`} text={monthName(y, m, i18n.language)}>
                {monthName(y, m, i18n.language)}
              </Option>
            )))}
          </Dropdown>
        </FilterField>
        <FilterChips
          label={t('time.fields.status')}
          value={status ?? 'all'}
          options={[{ value: 'all', label: t('common.all') }, ...timeStatuses.map((s) => ({ value: s, label: t(`time.statuses.${s}`), dot: statusDot[s] }))]}
          onChange={(value) => setParam('status', value === 'all' ? null : value)}
        />
      </Toolbar>

      {!error && (
        <StatGrid className={styles.stats} label={t('time.figuresLabel', { month: monthName(year, month, i18n.language) })}>
          <StatTile icon={<Clock16Regular />} tone="ember" label={t('time.fields.hours')} value={hours(data?.summary.hours)}
            note={t('time.billableTotal', { hours: formatNumber(data?.summary.billableHours ?? 0) })} />
          <StatTile icon={<CheckmarkCircle16Regular />} tone="spruce" label={t('time.statuses.Approved')} value={hours(data?.summary.approvedHours)} />
          <StatTile icon={<Hourglass16Regular />} tone="saffron" label={t('time.tiles.waiting')} value={hours(data?.summary.newHours)}
            note={period && !closed ? t('time.entriesCount', { count: period.newEntries }) : undefined} />
          {canSeeMoney && <StatTile icon={<Money16Regular />} tone="iris" label={t('time.tiles.toBill')}
            value={data ? formatMoney(data.summary.amount ?? 0) : t('myDay.loadingValue')} />}
        </StatGrid>
      )}

      <Panel flush headingRef={panelHeading} title={monthName(year, month, i18n.language)} icon={<CalendarLtr16Regular />} actions={(closedBadge || canManage || (closed && canUnlock)) && (
        <>
          {closedBadge}
          {canWithdraw && (
            <Button onClick={() => void withdraw()}>
              {t('time.withdrawSelected', { count: withdrawable.length })}
            </Button>
          )}
          {closed ? (
            canUnlock && (
              <Button {...restoreFocusTarget} icon={<LockOpen20Regular />} onClick={() => setReopening(period!)}>
                {t('time.reopenPeriod')}
              </Button>
            )
          ) : (
            canManage && (
              <Button {...restoreFocusTarget} icon={<LockClosed20Regular />} onClick={() => setClosingPeriod(true)}>
                {t('time.closePeriod', { month: monthName(year, month, i18n.language) })}
              </Button>
            )
          )}
          {canApprove && (
            <Button appearance="primary" icon={<CheckmarkCircle20Regular />} onClick={() => void approve()}>
              {t('time.approveSelected', { count: approvable.length })}
            </Button>
          )}
        </>
      )}>
        {error ? (
          <div className={styles.body}><ErrorState error={error} onRetry={() => void refetch()} /></div>
        ) : isPending ? (
          <div className={styles.loading}><Spinner size="small" label={t('common.loading')} /></div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Clock24Regular />}
            message={filtered ? t('time.emptyFiltered') : t('time.empty')}
            action={filtered && (
              <Button onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('status');
                next.delete('reviewOnly');
                setParams(next, { replace: true });
              }}>
                {t('time.showAll')}
              </Button>
            )}
          />
        ) : (
          <TimeEntriesTable entries={entries} selectable={canManage && !closed && entries.some(actionable)} canManage={canManage && !closed}
            canReview={canReview} canSeeMoney={canSeeMoney} selected={selected} onSelect={setSelected} onAdjust={setAdjusting} />
        )}
        <ListFooter shown={entries.length} total={data?.totalCount} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </Panel>

      {canManage && <TimePeriodsPanel periods={periods.data ?? []} month={month} hrefFor={monthHref} />}

      <Dialog open={adjusting !== null} onOpenChange={(_, d) => !d.open && setAdjusting(null)}>
        <DialogSurface>{shownEntry !== null && <AdjustDialog entry={shownEntry} onClose={() => setAdjusting(null)} />}</DialogSurface>
      </Dialog>
      {canManage && !closed && (
        <ClosePeriodDialog open={closingPeriod} year={year} month={month} waiting={period?.newEntries ?? 0}
          waitingHref={(() => { const next = new URLSearchParams(params); next.set('status', 'New'); return `?${next.toString()}`; })()}
          onClosed={() => { setClosingPeriod(false); setSelected([]); }} onCancel={() => setClosingPeriod(false)} />
      )}
      <Dialog open={reopening !== null} onOpenChange={(_, d) => !d.open && setReopening(null)}>
        <DialogSurface>{shownPeriod !== null && <ReopenDialog period={shownPeriod} onClose={() => setReopening(null)} />}</DialogSurface>
      </Dialog>
    </>
  );
}
