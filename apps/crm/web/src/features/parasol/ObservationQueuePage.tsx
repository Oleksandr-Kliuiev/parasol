import { useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, MessageBar, MessageBarBody, Switch, Text, makeStyles, mergeClasses, useRestoreFocusTarget } from '@fluentui/react-components';
import { AlertUrgent24Regular, ArrowClockwise20Regular, PersonAdd20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { EmptyState } from '../../shared/components/EmptyState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { FilterChips, Toolbar } from '../../shared/components/Toolbar';
import { activityKeys } from '../activities/api';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { attentionLimit } from './atlasAttentionContract';
import { AttentionStatus } from './AttentionStatus';
import { useAttentionStyles } from './attentionStyles';
import { assignToMe, type BulkResult } from './bulkAssign';
import { ObservationContext } from './ObservationContext';
import type { ObservationTaskLink } from './observationTaskContract';
import { ObservationWorkButton, type ObservationWorkControls } from './ObservationWorkButton';
import { queueKeyHandler, useShortcutSetting } from './queueKeys';
import { useTechnicalStyles } from './technicalStyles';
import { inFilter, partialCustomers, queueRows, type QueueFilter, type QueueRow } from './urgentQueue';
import { useAttentionRead } from './useAttentionRead';

const useStyles = makeStyles({
  stack: { display: 'grid', gap: '16px' },
  toolbarEnd: { display: 'flex', alignItems: 'center', gap: '8px' },
  hint: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' },
  // A row takes the keyboard's place in the queue: its focus ring is the one the person follows with J and K.
  row: {
    display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'start', gap: '4px 10px',
    ':focus-visible': { outline: `2px solid ${h.ember}`, outlineOffset: '2px' },
  },
  noCheck: { gridTemplateColumns: 'minmax(0, 1fr)' },
  main: { display: 'grid', gap: '4px', minWidth: 0 },
  customer: { display: 'inline-flex', alignItems: 'center', minHeight: '24px', fontSize: '13px', fontWeight: 700, color: h.muted, justifySelf: 'start' },
  notes: { display: 'grid', gap: '4px', color: h.muted, fontSize: '13px', lineHeight: '19px' },
});

/** The observation queue (UX 2026, В1): every urgent observation of the person's customers in one list. */
export function ObservationQueuePage() {
  const user = useCurrentUser();
  const canCustomers = useCan(Permissions.customersRead); const canAtlas = useCan(Permissions.parasolAtlasRead);
  if (!canCustomers || !canAtlas) return <ForbiddenPage />;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <UrgentQueue key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} />;
}

function UrgentQueue({ employeeId, permissionsKey }: { employeeId: string; permissionsKey: string }) {
  const { t } = useTranslation();
  const own = useStyles(); const attention = useAttentionStyles(); const technical = useTechnicalStyles();
  const user = useCurrentUser(); const client = useQueryClient();
  const canWrite = useCan(Permissions.activitiesWrite); const canRead = useCan(Permissions.activitiesRead);
  const canAssign = canWrite && canRead;
  const read = useAttentionRead('/api/v1/parasol/observations/urgent', attentionLimit.queue, ['parasol', 'observation-queue', employeeId, permissionsKey]);
  const [params, setParams] = useSearchParams();
  const filter = (['open', 'linked', 'all'] as const).find((value) => value === params.get('show')) ?? 'open';
  const [shortcuts, setShortcuts] = useShortcutSetting();
  // Tasks made from this page since the read, shown at once; a new read replaces them with what the server says.
  const [made, setMade] = useState<{ revision: number; links: ReadonlyMap<string, ObservationTaskLink> }>({ revision: 0, links: new Map() });
  const madeLinks = made.revision === read.revision ? made.links : new Map<string, ObservationTaskLink>();
  const remember = (key: string, link: ObservationTaskLink) =>
    setMade((current) => ({ revision: read.revision, links: new Map(current.revision === read.revision ? current.links : []).set(key, link) }));
  const rows = queueRows(read.data?.customers ?? []).map((row) => {
    const link = row.link ?? madeLinks.get(row.key);
    return link === row.link ? row : { ...row, link };
  });
  const shown = rows.filter((row) => inFilter(row, filter));
  const count = (value: QueueFilter) => rows.filter((row) => inFilter(row, value)).length;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectable = (row: QueueRow) => canAssign && row.tasksRead && !row.link;
  const chosen = shown.filter((row) => selected.has(row.key) && selectable(row));
  // One row is in the Tab order (roving focus): the one the person was last on, or the first.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const currentKey = shown.some((row) => row.key === focusKey) ? focusKey : shown[0]?.key;
  const controls = useRef(new Map<string, ObservationWorkControls>());
  const [confirming, setConfirming] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number; results: BulkResult[] } | null>(null);
  const running = bulk !== null && bulk.done < bulk.total;

  const setFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'open') next.delete('show'); else next.set('show', value);
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const toggle = (key: string, on?: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on ?? !next.has(key)) next.add(key); else next.delete(key);
    return next;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => queueKeyHandler(shortcuts, {
    open: (key) => controls.current.get(key)?.open(false),
    assign: (key) => { if (canAssign) controls.current.get(key)?.open(true); },
    toggle: (key) => { const row = shown.find((r) => r.key === key); if (row && selectable(row)) toggle(key); },
  })(event);
  // One after the other, each with its own fresh read (M12); the person sees how far it got and what did not go through.
  const assignChosen = async () => {
    const queue = chosen; setConfirming(false); setSelected(new Set());
    const results: BulkResult[] = [];
    setBulk({ done: 0, total: queue.length, results });
    for (const row of queue) {
      const result = await assignToMe(row.customerId, row.observation.id, { id: user.id, displayName: user.displayName });
      if (result.outcome === 'CREATED' || result.outcome === 'EXISTING') remember(row.key, result.link);
      results.push(result);
      setBulk({ done: results.length, total: queue.length, results: [...results] });
    }
    void client.invalidateQueries({ queryKey: activityKeys.all });
  };
  const summary = bulk && !running ? {
    created: bulk.results.filter((r) => r.outcome === 'CREATED').length,
    existing: bulk.results.filter((r) => r.outcome === 'EXISTING').length,
    failed: bulk.results.filter((r) => r.outcome === 'NOT_CREATED' || r.outcome === 'FAILED').length,
  } : null;
  const data = read.data;
  const partial = partialCustomers(data?.customers ?? []);
  const unread = (data?.customers ?? []).filter((c) => c.status !== 'READY');

  return (
    <>
      <PageHeader title={t('observationQueue.title')} subtitle={t('observationQueue.subtitle')}
        actions={<Button icon={<ArrowClockwise20Regular />} aria-label={t('observationQueue.refresh')} disabled={read.checking || running}
          disabledFocusable={read.checking} onClick={read.refresh}>{t('common.refresh')}</Button>} />
      <div className={own.stack}>
        <div className={attention.stack}>
          <AttentionStatus key={read.revision} read={read} note={t('observationQueue.note')} previewNote={t('observationQueue.previewNote')} />
        </div>
        {data && (
          <>
            <Toolbar label={t('observationQueue.filters')} end={
              <span className={own.toolbarEnd}>
                <Switch label={t('observationQueue.shortcuts')} checked={shortcuts} onChange={(_, d) => setShortcuts(d.checked)} />
              </span>}>
              <FilterChips label={t('observationQueue.show')} value={filter} onChange={setFilter} options={[
                { value: 'open', label: t('observationQueue.filter.open'), count: count('open') },
                { value: 'linked', label: t('observationQueue.filter.linked'), count: count('linked') },
                { value: 'all', label: t('observationQueue.filter.all'), count: count('all') },
              ]} />
            </Toolbar>
            {bulk && (
              <MessageBar intent={running || !summary?.failed ? 'info' : 'warning'} layout="multiline">
                <MessageBarBody>
                  <Text role="status">{running ? t('observationQueue.bulkRunning', { done: bulk.done, total: bulk.total })
                    : [t('observationQueue.bulkCreated', { count: summary!.created }),
                      summary!.existing > 0 && t('observationQueue.bulkExisting', { count: summary!.existing }),
                      summary!.failed > 0 && t('observationQueue.bulkFailed', { count: summary!.failed })].filter(Boolean).join(' ')}</Text>
                </MessageBarBody>
              </MessageBar>
            )}
            <Panel title={t(`observationQueue.filter.${filter}`)} icon={<AlertUrgent24Regular />} actions={canAssign && (
              <Button appearance="primary" icon={<PersonAdd20Regular />} disabled={chosen.length === 0 || running} onClick={() => setConfirming(true)}>
                {t('observationQueue.assignChosen', { count: chosen.length })}
              </Button>)}>
              <Text block id="queue-keys" className={own.hint}>{t(shortcuts ? 'observationQueue.keysOn' : 'observationQueue.keysOff')}</Text>
              {shown.length === 0 ? (
                <EmptyState compact icon={<AlertUrgent24Regular />} message={t(rows.length === 0 ? 'observationQueue.empty' : `observationQueue.emptyFilter.${filter}`)}
                  action={filter !== 'all' && rows.length > 0 && <Button onClick={() => setFilter('all')}>{t('observationQueue.showAll')}</Button>} />
              ) : (
                <ul className={own.list} aria-label={t('observationQueue.title')} aria-describedby="queue-keys" onKeyDown={onKeyDown}>
                  {shown.map((row) => (
                    <QueueRowItem key={row.key} row={row} selectable={selectable(row)} selected={selected.has(row.key)}
                      focusable={row.key === currentKey}
                      onFocus={setFocusKey} onSelect={toggle} onTask={remember} onSourceInvalidated={read.refresh}
                      controls={(handle) => { if (handle) controls.current.set(row.key, handle); else controls.current.delete(row.key); }}
                      raised={technical.raisedRow} rowClass={technical.row} />
                  ))}
                </ul>
              )}
              {(partial.length > 0 || unread.length > 0) && (
                <div className={own.notes}>
                  {partial.map((c) => <Text block key={c.customerId}>
                    <AppLink to={`/organizations/${c.customerId}`}>{c.customerName}</AppLink>: {t('observationQueue.partial', { shown: c.shown, total: c.total })}
                  </Text>)}
                  {unread.map((c) => <Text block key={c.customerId}>
                    <AppLink to={`/organizations/${c.customerId}`}>{c.customerName}</AppLink>: {t(`parasolAttention.customerStatus.${c.status}`)}
                  </Text>)}
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
      <ConfirmDialog open={confirming} title={t('observationQueue.confirmTitle', { count: chosen.length })} confirm={t('observationQueue.confirm')}
        onConfirm={() => void assignChosen()} onCancel={() => setConfirming(false)}>
        {t('observationQueue.confirmBody')}
      </ConfirmDialog>
    </>
  );
}

function QueueRowItem({ row, selectable, selected, focusable, onFocus, onSelect, onTask, onSourceInvalidated, controls, raised, rowClass }: {
  row: QueueRow; selectable: boolean; selected: boolean; focusable: boolean; onFocus: (key: string) => void;
  onSelect: (key: string, on: boolean) => void; onTask: (key: string, link: ObservationTaskLink) => void; onSourceInvalidated: () => void;
  controls: (handle: ObservationWorkControls | null) => void; raised: string; rowClass: string;
}) {
  const { t } = useTranslation(); const own = useStyles(); const restore = useRestoreFocusTarget();
  return (
    <li data-queue-row={row.key} tabIndex={focusable ? 0 : -1} {...restore} aria-label={t('observationQueue.rowLabel', { customer: row.customerName, summary: row.observation.summary })}
      className={mergeClasses(rowClass, raised, own.row, !selectable && own.noCheck)} onFocus={(event) => { if (event.target === event.currentTarget) onFocus(row.key); }}>
      {selectable && <Checkbox checked={selected} onChange={(_, d) => onSelect(row.key, d.checked === true)}
        aria-label={t('observationQueue.select', { summary: row.observation.summary })} />}
      <div className={own.main}>
        <AppLink className={own.customer} to={`/organizations/${row.customerId}`}>{row.customerName}</AppLink>
        <ObservationContext observation={row.observation} devices={row.devices} task={row.link}
          action={<ObservationWorkButton customerId={row.customerId} observationId={row.observation.id} status={row.observation.status}
            linked={Boolean(row.link)} onTask={(link) => onTask(row.key, link)} onSourceInvalidated={onSourceInvalidated} controls={controls} />} />
      </div>
    </li>
  );
}
