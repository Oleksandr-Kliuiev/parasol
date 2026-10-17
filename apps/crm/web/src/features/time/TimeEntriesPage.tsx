import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, LockClosed20Regular, LockOpen20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { usePeriodActions, usePeriods, useTimeActions, useTimeEntries } from './api';
import { timeStatuses, type Period, type TimeEntry, type TimeEntryStatus } from './types';

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  spacer: { flex: 1 },
  allocations: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  // Plain text rather than tinted badges: the same row is read in both themes, and the label already says everything.
  allocation: {
    paddingInline: tokens.spacingHorizontalXS,
    borderInlineStartWidth: '2px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens.colorBrandStroke2,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
  review: { color: tokens.colorPaletteDarkOrangeForeground1, fontSize: tokens.fontSizeBase200 },
  periods: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: tokens.spacingVerticalXS },
  period: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, paddingBlock: tokens.spacingVerticalXXS },
});

const monthName = (year: number, month: number, language: string) =>
  new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 1)));

/** Everyone's hours for a month: correct, approve and close the period (FR-TIM-03). */
export function TimeEntriesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const canManage = useCan(Permissions.timeManage);
  const canSeeMoney = useCan(Permissions.financeRead);
  const canUnlock = useCan(Permissions.timeUnlock);
  const actions = useTimeActions();
  const periodActions = usePeriodActions();
  const [params, setParams] = useSearchParams();
  const now = new Date();
  const year = Number(params.get('year') ?? now.getFullYear());
  const month = Number(params.get('month') ?? now.getMonth() + 1);
  const status = (params.get('status') as TimeEntryStatus | null) ?? null;
  const [selected, setSelected] = useState<string[]>([]);
  const [adjusting, setAdjusting] = useState<TimeEntry | null>(null);
  const [reopening, setReopening] = useState<Period | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  const pages = useTimeEntries({ year, month, status });
  // The summary of the newest answer covers every entry the filter matches, not only the rows loaded so far.
  const data = pages.latest;
  const { error, isPending, refetch } = pages;
  const periods = usePeriods(year);
  const period = periods.data?.find((p) => p.month === month);
  const entries = pages.items;
  const selectable = entries.filter((e) => e.status === 'New' && !e.isLocked).map((e) => e.id);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected([]);
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
      setSelected([]);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const approve = async () => {
    try {
      const result = await actions.approve.mutateAsync(selected);
      notify(
        t('time.approved', { count: result.data.approved }),
        result.data.skipped > 0 ? 'warning' : 'success',
        result.data.skipped > 0 ? result.data.skippedReasons.join(' ') : undefined,
      );
      setSelected([]);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader title={t('time.title')} subtitle={t('time.subtitle')} />
      <div className={styles.filters}>
        <Field label={t('time.fields.period')}>
          <Dropdown
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
        </Field>
        <Field label={t('time.fields.status')}>
          <Dropdown
            value={status ? t(`time.statuses.${status}`) : t('common.all')}
            selectedOptions={[status ?? '']}
            onOptionSelect={(_, d) => setParam('status', d.optionValue || null)}
          >
            <Option value="">{t('common.all')}</Option>
            {timeStatuses.map((s) => (
              <Option key={s} value={s}>
                {t(`time.statuses.${s}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </div>

      <div className={styles.bar}>
        <Text>
          {t('time.totals', {
            hours: formatNumber(data?.summary.hours ?? 0),
            approved: formatNumber(data?.summary.approvedHours ?? 0),
            pending: formatNumber(data?.summary.newHours ?? 0),
          })}
        </Text>
        {canSeeMoney && <Text className={catalog.muted}>{t('time.amountTotal', { amount: formatMoney(data?.summary.amount ?? 0) })}</Text>}
        {period?.isClosed && (
          <Badge appearance="tint" color="informative" icon={<LockClosed20Regular />}>
            {t('time.periodClosed', { at: period.closedAt ? formatDate(period.closedAt) : '', by: period.closedByName ?? '' })}
          </Badge>
        )}
        <span className={styles.spacer} />
        {canManage && (
          <>
            <Button appearance="primary" icon={<CheckmarkCircle20Regular />} disabled={selected.length === 0} onClick={() => void approve()}>
              {t('time.approveSelected', { count: selected.length })}
            </Button>
            <Button disabled={selected.length === 0} onClick={() => void run(() => actions.withdraw.mutateAsync(selected), t('time.withdrawn'))}>
              {t('time.withdrawSelected')}
            </Button>
          </>
        )}
        {period?.isClosed ? (
          canUnlock && (
            <Button {...restoreFocusTarget} icon={<LockOpen20Regular />} onClick={() => setReopening(period)}>
              {t('time.reopenPeriod')}
            </Button>
          )
        ) : (
          canManage && (
            <Button icon={<LockClosed20Regular />}
              onClick={() => void run(() => periodActions.close.mutateAsync({ year, month }), t('time.periodClosedDone'))}>
              {t('time.closePeriod')}
            </Button>
          )
        )}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('time.title')}>
            <TableHeader>
              <TableRow>
                {canManage && (
                  <TableHeaderCell>
                    <Checkbox
                      aria-label={t('time.selectAll')}
                      checked={selected.length > 0 && selected.length === selectable.length ? true : selected.length > 0 ? 'mixed' : false}
                      disabled={selectable.length === 0}
                      onChange={(_, d) => setSelected(d.checked ? selectable : [])}
                    />
                  </TableHeaderCell>
                )}
                <TableHeaderCell>{t('time.fields.workDate')}</TableHeaderCell>
                <TableHeaderCell>{t('time.fields.organization')}</TableHeaderCell>
                <TableHeaderCell>{t('time.fields.technician')}</TableHeaderCell>
                <TableHeaderCell>{t('time.fields.work')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('time.fields.hours')}</TableHeaderCell>
                <TableHeaderCell>{t('time.fields.billing')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('time.fields.amount')}</TableHeaderCell>}
                {canManage && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  {canManage && (
                    <TableCell>
                      <Checkbox
                        aria-label={t('time.selectEntry', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}
                        checked={selected.includes(entry.id)}
                        disabled={entry.isLocked || (entry.status !== 'New' && entry.status !== 'Approved' && entry.status !== 'NonBillable')}
                        onChange={(_, d) => setSelected((ids) => (d.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id)))}
                      />
                    </TableCell>
                  )}
                  <TableCell className="tabular">{formatDate(entry.workDate)}</TableCell>
                  <TableCell>
                    <AppLink to={`/organizations/${entry.organizationId}`}>{entry.organizationName}</AppLink>
                  </TableCell>
                  <TableCell>{entry.technicianName}</TableCell>
                  <TableCell>
                    {entry.description ?? entry.ticketTitle}
                    <div className={catalog.sku}>
                      {entry.workType}
                      {entry.externalTicketId ? ` · #${entry.externalTicketId}` : ''}
                      {entry.source === 'Atera' ? ' · Atera' : ''}
                    </div>
                    {entry.reviewNote && <div className={styles.review}>{entry.reviewNote}</div>}
                  </TableCell>
                  <TableCell className={catalog.number}>{formatNumber(entry.hours)}</TableCell>
                  <TableCell>
                    <span className={styles.allocations}>
                      {entry.status === 'New' || entry.allocations.length === 0 ? (
                        <Text className={styles.allocation}>{t(`time.statuses.${entry.status}`)}</Text>
                      ) : (
                        entry.allocations.map((allocation, index) => (
                          <Text key={index} className={styles.allocation}>
                            {t(`time.classifications.${allocation.classification}`)} {formatNumber(allocation.hours)} {t('contracts.hoursShort')}
                          </Text>
                        ))
                      )}
                    </span>
                  </TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(entry.amount)}</TableCell>}
                  {canManage && (
                    <TableCell>
                      {entry.status === 'New' && !entry.isLocked && (
                        <Button {...restoreFocusTarget} size="small" appearance="subtle" onClick={() => setAdjusting(entry)}
                          aria-label={t('time.adjustNamed', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}>
                          {t('time.adjust')}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && entries.length === 0 && <EmptyState message={t('time.empty')} />}
          <ListFooter shown={entries.length} total={data?.totalCount} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
        </div>
      )}

      {canManage && (
        <Panel title={t('time.periods')}>
          <ul className={styles.periods}>
            {(periods.data ?? []).map((p) => (
              <li key={p.month} className={styles.period}>
                <Text weight={p.month === month ? 'semibold' : 'regular'}>{monthName(p.year, p.month, i18n.language)}</Text>
                <Text className="tabular">
                  {formatNumber(p.hours)} {t('contracts.hoursShort')}
                </Text>
                {p.isClosed ? (
                  <Badge appearance="tint" color="informative" icon={<LockClosed20Regular />}>
                    {t('time.closed')}
                  </Badge>
                ) : p.newEntries > 0 ? (
                  <Badge appearance="tint" color="warning">
                    {t('time.pendingCount', { count: p.newEntries })}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Dialog open={adjusting !== null} onOpenChange={(_, d) => !d.open && setAdjusting(null)}>
        <DialogSurface>{adjusting !== null && <AdjustDialog entry={adjusting} onClose={() => setAdjusting(null)} />}</DialogSurface>
      </Dialog>
      <Dialog open={reopening !== null} onOpenChange={(_, d) => !d.open && setReopening(null)}>
        <DialogSurface>{reopening !== null && <ReopenDialog period={reopening} onClose={() => setReopening(null)} />}</DialogSurface>
      </Dialog>
    </>
  );
}

function AdjustDialog({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useTimeActions();
  const [billable, setBillable] = useState(entry.billable);
  const [afterHours, setAfterHours] = useState(entry.afterHours);
  const [workType, setWorkType] = useState(entry.workType ?? '');

  const submit = async () => {
    try {
      await actions.adjust.mutateAsync({ id: entry.id, billable, workType: workType.trim() || null, afterHours });
      notify(t('time.adjusted'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('time.adjustTitle')}</DialogTitle>
        <DialogContent>
          {actions.adjust.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.adjust.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{t('time.adjustBody')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Checkbox label={t('time.fields.billable')} checked={billable} onChange={(_, d) => setBillable(Boolean(d.checked))} />
            <Checkbox label={t('time.fields.afterHours')} checked={afterHours} onChange={(_, d) => setAfterHours(Boolean(d.checked))} />
            <Field label={t('time.fields.workType')}>
              <Input value={workType} onChange={(_, d) => setWorkType(d.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={actions.adjust.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function ReopenDialog({ period, onClose }: { period: Period; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const actions = usePeriodActions();
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await actions.reopen.mutateAsync({ year: period.year, month: period.month, reason: reason.trim() });
      notify(t('time.periodReopened'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('time.reopenTitle', { period: monthName(period.year, period.month, i18n.language) })}</DialogTitle>
        <DialogContent>
          {actions.reopen.error instanceof ApiError && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.reopen.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <Field label={t('time.reopenReason')} required hint={t('time.reopenHint')}>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || actions.reopen.isPending}>
            {t('time.reopenPeriod')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
