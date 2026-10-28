import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button, Dropdown, Option, SearchBox, Skeleton, SkeletonItem, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { ArrowClockwise20Regular, ShieldTask20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Permissions, useCan, useCurrentUser } from '../../../auth/CurrentUserContext';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { PageHeader } from '../../../shared/components/PageHeader';
import { FilterChips, FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useDebouncedValue } from '../../../shared/utils/useDebouncedValue';
import { useBatchAvailable } from '../../actions/api';
import type { ActionBatchResult } from '../../actions/types';
import { ForbiddenPage } from '../../errors/ForbiddenPage';
import { alertSeverities, type AlertSeverity } from '../types';
import { CustomerFilter } from '../CustomerFilter';
import { AlertActionsHost } from './AlertActions';
import { AlertBulkBar } from './AlertBulkBar';
import { AlertBulkCloseDialog } from './AlertBulkCloseDialog';
import { AlertBulkHideDialog } from './AlertBulkHideDialog';
import { AlertBulkNotice, type RecentBulk } from './AlertBulkNotice';
import { AlertDetailDrawer } from './AlertDetailDrawer';
import { AlertReadLine } from './AlertReadLine';
import { AlertQueueEmpty, AlertQueueList } from './AlertQueueList';
import { AlertTaskDialogHost } from './AlertTaskDialogHost';
import { CoverageRulesDialog } from './CoverageRulesDialog';
import { atSource, hideable, selectMatching, showable, useAlertSelection, type ChosenAlert, type HiddenTogether } from './alertBulk';
import { focusList } from './alertSourceActions';
import { sourceName } from './alertText';
import { pageIds, useAlertTaskLinks } from './alertTasks';
import { useAlertQueue } from './useAlertQueue';

const useStyles = makeStyles({
  totals: { display: 'block', marginBottom: '12px', color: h.muted, fontSize: '13px', lineHeight: '19px', fontVariantNumeric: 'tabular-nums' },
});

const severityParam: Record<string, AlertSeverity> = { critical: 'Critical', warning: 'Warning' };

/**
 * M45: the sources whose alerts the queue lists. CloudAlly sends none of its own: Parasoll's backup checks list its problems as gaps
 * (M42), under Parasoll.
 */
const sources = ['atera', 'huntress', 'parasoll'] as const;

/** M45: the ages offered, in days; another number in the address (`?olderThan=45`) is offered beside them. */
const ages = [7, 30, 90, 365] as const;

/** The most alerts one bulk action takes, as the server answers "all that match". */
const bulkLimit = 500;

const ageParam = (value: string | null) => {
  const days = Number(value);
  return value !== null && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
};

/** Alerts across customers (M38, Work → Alerts): one queue to look at the most severe and longest waiting first. */
export function AlertQueuePage() {
  const user = useCurrentUser();
  const canService = useCan(Permissions.serviceRead);
  if (!canService) return <ForbiddenPage />;
  // A new person or new rights start with a new queue: no rows, task links or panel of the previous reader stay on screen.
  return <Queue key={`${user.id}:${[...user.permissions].sort().join(',')}`} />;
}

function Queue() {
  const { t } = useTranslation(); const styles = useStyles();
  const [params, setParams] = useSearchParams(); const location = useLocation(); const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [checks, setChecks] = useState(false); const restore = useRestoreFocusTarget();
  const debounced = useDebouncedValue(search.trim());
  const state = params.get('state') === 'resolved' ? 'Resolved' : params.get('state') === 'hidden' ? 'Hidden' : 'Open';
  const severity = severityParam[params.get('severity') ?? ''] ?? null;
  const organizationId = params.get('customer');
  // M45: the source as stored and an age; both live in the address like the other filters.
  const system = params.get('source');
  const olderThanDays = ageParam(params.get('olderThan'));
  const filters = { state, severity, organizationId, search: debounced, system, olderThanDays } as const;
  const queue = useAlertQueue(filters);
  const links = useAlertTaskLinks(pageIds(queue.pages));
  const filtered = severity !== null || organizationId !== null || debounced !== '' || system !== null || olderThanDays !== null;
  // While another search or filter is read, the previous rows stay where they are, so a click on one still lands. They are not its
  // answer: the count line says the queue is loading, and no count, end of list or empty answer is claimed for them.
  const stale = queue.isPlaceholderData;
  const notify = useNotify(); const restoreBulk = useRestoreFocusTarget();
  // M45: people who may act on alerts choose them in the open and hidden lists, for one bulk action; another view starts with none.
  const selectable = useCan(Permissions.serviceWrite) && state !== 'Resolved';
  const selection = useAlertSelection(JSON.stringify(filters));
  const chosen = [...selection.chosen.values()];
  const closing = atSource(chosen, 'atera'); const hiding = hideable(chosen); const showing = showable(chosen);
  const canClose = useBatchAvailable('atera', 'alert.resolve', selectable && closing.length > 0);
  const [bulk, setBulk] = useState<{ kind: 'close' | 'hide' | 'show'; alerts: ChosenAlert[]; followed?: ActionBatchResult } | null>(null);
  // M45: the last bulk action stays said above the list (a batch followed to its end, the way back from a hide) until dismissed.
  const [recent, setRecent] = useState<RecentBulk | null>(null);
  const [selecting, setSelecting] = useState(false);
  const selectAll = async () => {
    setSelecting(true);
    const since = selection.version;
    try {
      selection.chooseMatching(await selectMatching(filters), since);
    } catch (failure) {
      notify(errorMessage(failure, t), 'error');
    } finally {
      setSelecting(false);
    }
  };
  // A bulk action that changed something ends the selection; the button that opened it is gone with it, so focus goes to the list.
  const finishBulk = (changed: boolean, hidden?: HiddenTogether) => {
    // A hide leaves its way back above the list; showing alerts again makes an earlier hide's way back say what is no longer so.
    if (hidden) setRecent({ kind: 'hide', ...hidden });
    else if (changed && bulk?.kind === 'show') setRecent((previous) => previous?.kind === 'hide' ? null : previous);
    setBulk(null);
    if (changed) { selection.clear(); focusList(); }
  };

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  // The side panel of one alert has its own address (?alert=), so Back closes it and My day can open it.
  const peekId = params.get('alert');
  const openPeek = (id: string) => { const next = new URLSearchParams(params); next.set('alert', id); setParams(next, { state: { alertPeek: true } }); };
  const closePeek = () => {
    if ((location.state as { alertPeek?: boolean } | null)?.alertPeek) { void navigate(-1); return; }
    setParam('alert', null);
  };
  const clear = () => {
    setSearch('');
    const next = new URLSearchParams(params);
    for (const key of ['severity', 'customer', 'source', 'olderThan']) next.delete(key);
    setParams(next, { replace: true });
  };
  const ageLabel = (days: number) => days === 365 ? t('alerts.olderThanYear') : t('alerts.olderThan', { count: days });

  const total = queue.total;
  const empty = <AlertQueueEmpty
    message={t(filtered ? 'alerts.emptyFiltered' : state === 'Resolved' ? 'alerts.emptyResolved' : state === 'Hidden' ? 'alerts.emptyHidden' : 'alerts.empty')}
    action={filtered && <Button onClick={clear}>{t('alerts.clearFilters')}</Button>} />;

  // The assign dialog and the action confirmation are held above the list, which reloads (search, filters) and switches between
  // table and cards.
  return <AlertTaskDialogHost><AlertActionsHost>
    <PageHeader title={t('alerts.title')} subtitle={t(state === 'Resolved' ? 'alerts.subtitleResolved' : state === 'Hidden' ? 'alerts.subtitleHidden' : 'alerts.subtitle')}
      // How fresh the stored alerts are, from the same answer as the rows: no time is shown while a new read is under way.
      meta={queue.reads && !queue.error && !(queue.isFetching && !queue.isFetchingNextPage) && <AlertReadLine reads={queue.reads} />}
      actions={<>
        {/* M40: Parasoll's own coverage checks, whose gaps are listed here among the alerts. */}
        <Button {...restore} icon={<ShieldTask20Regular />} onClick={() => setChecks(true)}>{t('coverage.open')}</Button>
        <Button icon={<ArrowClockwise20Regular />} aria-label={t('alerts.refresh')} disabled={queue.isFetching} disabledFocusable={queue.isFetching}
          onClick={() => void queue.refetch()}>{t('common.refresh')}</Button>
      </>} />
    <Toolbar label={t('alerts.filters')}>
      <FilterField kind="search" label={t('alerts.search')}>
        <SearchBox value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('alerts.search')} />
      </FilterField>
      <FilterChips<'Open' | 'Hidden' | 'Resolved'> label={t('alerts.stateLabel')} value={state}
        onChange={(value) => setParam('state', value === 'Open' ? null : value.toLowerCase())}
        options={[{ value: 'Open', label: t('alerts.show.open') }, { value: 'Hidden', label: t('alerts.show.hidden') },
          { value: 'Resolved', label: t('alerts.show.resolved') }]} />
      <FilterChips<'' | AlertSeverity> label={t('alerts.severityLabel')} value={severity ?? ''}
        onChange={(value) => setParam('severity', value ? value.toLowerCase() : null)}
        options={[{ value: '', label: t('alerts.allSeverities') },
          ...alertSeverities.map((value) => ({ value, label: t(`service.severities.${value}`), dot: value === 'Critical' ? h.ember : h.saffron }))]} />
      <FilterField label={t('alerts.customerFilter')}>
        <CustomerFilter value={organizationId} onChange={(id) => setParam('customer', id)} placeholder={t('alerts.anyCustomer')} />
      </FilterField>
      <FilterField label={t('alerts.sourceLabel')}>
        <Dropdown value={system ? sourceName(t, system) : t('alerts.allSources')} selectedOptions={[system ?? '']}
          onOptionSelect={(_, d) => setParam('source', d.optionValue || null)}>
          <Option value="">{t('alerts.allSources')}</Option>
          {[...sources, ...(system && !(sources as readonly string[]).includes(system) ? [system] : [])].map((value) =>
            <Option key={value} value={value}>{sourceName(t, value)}</Option>)}
        </Dropdown>
      </FilterField>
      <FilterField label={t('alerts.ageLabel')}>
        <Dropdown value={olderThanDays ? ageLabel(olderThanDays) : t('alerts.anyAge')} selectedOptions={[olderThanDays ? String(olderThanDays) : '']}
          onOptionSelect={(_, d) => setParam('olderThan', d.optionValue || null)}>
          <Option value="">{t('alerts.anyAge')}</Option>
          {[...new Set<number>([...ages, ...(olderThanDays ? [olderThanDays] : [])])].sort((a, b) => a - b).map((days) =>
            <Option key={days} value={String(days)}>{ageLabel(days)}</Option>)}
        </Dropdown>
      </FilterField>
    </Toolbar>
    {queue.error ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} /> : queue.isPending || (stale && queue.items.length === 0)
      ? <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>
      : <>
        {/* The counts are of everything the filters match, read with the list (DEV-12). */}
        {total !== null && total > 0 && <Text className={styles.totals} role="status">
          {stale ? t('common.loading') : t('alerts.totals', { count: total, critical: queue.critical ?? 0, warning: queue.warning ?? 0 })}
        </Text>}
        {recent && <AlertBulkNotice recent={recent} onDismiss={() => { setRecent(null); focusList(); }}
          onShow={() => { if (recent.kind === 'close') setBulk({ kind: 'close', alerts: recent.alerts, followed: recent.result }); }} />}
        {/* M45: what is chosen and what can be done with it, above the rows it is chosen from; there while rows can be chosen, so the
            first box ticked moves no row. */}
        {selectable && queue.items.length > 0 && <AlertBulkBar count={selection.chosen.size} shown={queue.items.length} total={stale ? null : total}
          matching={selection.matching} limit={bulkLimit} selecting={selecting} onSelectMatching={() => void selectAll()}
          onClear={() => { selection.clear(); focusList(); }}
          actions={<>
            {canClose && closing.length > 0 && <Button {...restoreBulk} onClick={() => setBulk({ kind: 'close', alerts: chosen })}>
              {t('alerts.bulk.closeInAtera', { count: closing.length })}</Button>}
            {state === 'Open' && hiding.length > 0 && <Button {...restoreBulk} onClick={() => setBulk({ kind: 'hide', alerts: hiding })}>
              {t('alerts.bulk.hideAction', { count: hiding.length })}</Button>}
            {state === 'Hidden' && showing.length > 0 && <Button {...restoreBulk} onClick={() => setBulk({ kind: 'show', alerts: showing })}>
              {t('alerts.bulk.showAction', { count: showing.length })}</Button>}
          </>} />}
        {/* The headings and ages are those of the rows on screen: while another state is read, they are still of the earlier one. */}
        <AlertQueueList alerts={queue.items} tasks={links.links} resolved={(stale ? queue.items[0]?.state : state) === 'Resolved'} busy={stale}
          selection={selectable ? {
            disabled: stale, isChosen: (id) => selection.chosen.has(id), onToggle: selection.toggle, onToggleAll: (on) => selection.toggleAll(queue.items, on),
          } : undefined}
          empty={empty} onOpen={(alert) => openPeek(alert.id)}
          footer={<ListFooter shown={queue.items.length} total={stale ? null : total} hasMore={Boolean(queue.hasNextPage)} loading={queue.isFetchingNextPage}
            onMore={() => void queue.fetchNextPage()} />} />
      </>}
    <AlertDetailDrawer alertId={peekId} onClose={closePeek} />
    {checks && <CoverageRulesDialog onClose={() => setChecks(false)} />}
    <AlertBulkCloseDialog alerts={bulk?.kind === 'close' ? bulk.alerts : null} followed={bulk?.kind === 'close' ? bulk.followed : null}
      onAsked={(result) => { if (bulk) setRecent({ kind: 'close', alerts: bulk.alerts, result }); }} onClose={(asked) => finishBulk(asked)} />
    {bulk && bulk.kind !== 'close' && <AlertBulkHideDialog mode={bulk.kind} alerts={bulk.alerts} onClose={finishBulk} />}
  </AlertActionsHost></AlertTaskDialogHost>;
}
