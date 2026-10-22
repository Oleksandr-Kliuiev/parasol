import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button, SearchBox, Skeleton, SkeletonItem, Text, makeStyles } from '@fluentui/react-components';
import { ArrowClockwise20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Permissions, useCan, useCurrentUser } from '../../../auth/CurrentUserContext';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { PageHeader } from '../../../shared/components/PageHeader';
import { FilterChips, FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { useDebouncedValue } from '../../../shared/utils/useDebouncedValue';
import { ForbiddenPage } from '../../errors/ForbiddenPage';
import { alertSeverities, type AlertSeverity } from '../types';
import { CustomerFilter } from '../CustomerFilter';
import { AlertActionsHost } from './AlertActions';
import { AlertDetailDrawer } from './AlertDetailDrawer';
import { AlertReadLine } from './AlertReadLine';
import { AlertQueueEmpty, AlertQueueList } from './AlertQueueList';
import { AlertTaskDialogHost } from './AlertTaskDialogHost';
import { pageIds, useAlertTaskLinks } from './alertTasks';
import { useAlertQueue } from './useAlertQueue';

const useStyles = makeStyles({
  totals: { display: 'block', marginBottom: '12px', color: h.muted, fontSize: '13px', lineHeight: '19px', fontVariantNumeric: 'tabular-nums' },
});

const severityParam: Record<string, AlertSeverity> = { critical: 'Critical', warning: 'Warning' };

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
  const debounced = useDebouncedValue(search.trim());
  const state = params.get('state') === 'resolved' ? 'Resolved' : params.get('state') === 'hidden' ? 'Hidden' : 'Open';
  const severity = severityParam[params.get('severity') ?? ''] ?? null;
  const organizationId = params.get('customer');
  const filters = { state, severity, organizationId, search: debounced } as const;
  const queue = useAlertQueue(filters);
  const links = useAlertTaskLinks(pageIds(queue.pages));
  const filtered = severity !== null || organizationId !== null || debounced !== '';

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
    const next = new URLSearchParams(params); next.delete('severity'); next.delete('customer');
    setParams(next, { replace: true });
  };

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
      actions={<Button icon={<ArrowClockwise20Regular />} aria-label={t('alerts.refresh')} disabled={queue.isFetching} disabledFocusable={queue.isFetching}
        onClick={() => void queue.refetch()}>{t('common.refresh')}</Button>} />
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
    </Toolbar>
    {queue.error ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} /> : queue.isPending
      ? <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>
      : <>
        {/* The counts are of everything the filters match, read with the list (DEV-12). */}
        {total !== null && total > 0 && <Text className={styles.totals} role="status">
          {t('alerts.totals', { count: total, critical: queue.critical ?? 0, warning: queue.warning ?? 0 })}
        </Text>}
        <AlertQueueList alerts={queue.items} tasks={links.links} resolved={state === 'Resolved'} empty={empty} onOpen={(alert) => openPeek(alert.id)}
          footer={<ListFooter shown={queue.items.length} total={total} hasMore={Boolean(queue.hasNextPage)} loading={queue.isFetchingNextPage}
            onMore={() => void queue.fetchNextPage()} />} />
      </>}
    <AlertDetailDrawer alertId={peekId} onClose={closePeek} />
  </AlertActionsHost></AlertTaskDialogHost>;
}
