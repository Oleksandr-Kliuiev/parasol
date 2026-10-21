import { useId, useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
  Badge,
  type BadgeProps,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Gauge16Regular, Gauge24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { PersonCell } from '../admin/settingsUi';
import { useTableCardStyles } from '../admin/tableCard';
import { ScrollRegion } from '../admin/ScrollRegion';
import { useTranslation } from 'react-i18next';
import type { UserRef } from '../../api/types';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { UserPicker } from '../../shared/components/UserPicker';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { systemName } from './labels';
import { useMonitoring, useTriage, type MonitoringException, type TriageStatus } from './monitoringApi';

interface Filters { category: string; source: string; status: string; owner: string }
interface SavedView { name: string; filters: Filters }
const emptyFilters: Filters = { category: '', source: '', status: '', owner: '' };
const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  intro: { display: 'grid', gap: '2px' },
  // Filters and saved views: two rows of the same toolbar, the views set apart by a hairline.
  filters: { marginBottom: 0 },
  views: { marginBottom: '-8px', paddingTop: '16px', borderTop: `1px solid ${h.line}` },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  cellLine: { display: 'block', marginTop: '2px' },
  count: { fontWeight: tokens.fontWeightSemibold },
  comment: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '320px' },
  dialog: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

const freshnessColor: Record<string, BadgeProps['color']> = { Fresh: 'success', Stale: 'warning', Never: 'danger', Paused: 'warning', Disabled: 'subtle' };
const triageColor: Record<string, BadgeProps['color']> = { Open: 'warning', InProgress: 'informative', Resolved: 'success' };

function readViews(key: string): SavedView[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is SavedView => typeof v?.name === 'string' && v.name.length <= 40 &&
      v.filters && ['category', 'source', 'status', 'owner'].every((k) => typeof v.filters[k] === 'string')).slice(0, 10);
  } catch { return []; }
}

export function MonitoringPanel() {
  const user = useCurrentUser();
  return <AccountMonitoringPanel key={user.id} />;
}

function AccountMonitoringPanel() {
  const { t } = useTranslation();
  const styles = useStyles();
  const table = useTableCardStyles();
  const user = useCurrentUser();
  const allowed = useCan(Permissions.integrationsManage);
  const monitoring = useMonitoring(allowed);
  const storageKey = `crm.monitoring.views.${user.id}`;
  const [views, setViews] = useState(() => readViews(storageKey));
  const [viewName, setViewName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [editing, setEditing] = useState<MonitoringException | null>(null);
  const shownException = useKeptWhileClosing(editing);
  const restoreFocusTarget = useRestoreFocusTarget();
  if (!allowed) return null;

  const exceptions = monitoring.data?.exceptions ?? [];
  const recoveredShown = exceptions.filter((e) => !e.active).length;
  const recoveredTotal = monitoring.data?.recoveredTotalCount ?? recoveredShown;
  const total = exceptions.length - recoveredShown + recoveredTotal;
  const shown = exceptions.filter((e) => (!filters.category || e.category === filters.category) &&
    (!filters.source || e.source === filters.source) && (!filters.status || e.triage.status === filters.status) &&
    (!filters.owner || (filters.owner === 'Mine' ? e.triage.ownerId === user.id : !e.triage.ownerId)));
  const changeFilter = (name: keyof Filters, value: string) => { setFilters((f) => ({ ...f, [name]: value })); setSavedName(''); };
  const saveViews = (next: SavedView[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setViews(next); setStorageFailed(false); return true; }
    catch { setStorageFailed(true); return false; }
  };
  const kindName = (kind: string) => t(`monitoring.kinds.${kind}`, { defaultValue: t('monitoring.kinds.Other') });
  /** Minutes as people read them: 15 min, 36 h 15 min, 3 d 2 h. */
  const span = (minutes: number) => {
    if (minutes <= 120) return t('monitoring.span.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return minutes % 60 ? t('monitoring.span.hoursMinutes', { hours, minutes: minutes % 60 }) : t('monitoring.span.hours', { count: hours });
    return hours % 24 ? t('monitoring.span.daysHours', { days: Math.floor(hours / 24), hours: hours % 24 }) : t('monitoring.span.days', { count: hours / 24 });
  };

  return (
    <Panel title={t('monitoring.title')} icon={<Gauge16Regular />} actions={<Button onClick={() => void monitoring.refetch()} disabled={monitoring.isFetching}>{t('common.refresh')}</Button>}>
      <div className={styles.stack}>
        <div className={styles.intro}>
          <Text>{t('monitoring.description')}</Text>
          {monitoring.data && <Text className={styles.muted}>{t('monitoring.checkedAt', { at: formatDateTime(monitoring.data.checkedAt) })}</Text>}
        </div>
        {monitoring.error ? <ErrorState error={monitoring.error} onRetry={() => void monitoring.refetch()} /> : monitoring.isPending ? <Spinner label={t('common.loading')} /> : <>
          <ScrollRegion className={table.inset} label={t('monitoring.sources')}>
            <Table size="small" className={mergeClasses(table.min800, table.roomy)} aria-label={t('monitoring.sources')}>
              <TableHeader><TableRow>
                {['source', 'lastSuccess', 'freshness', 'latestAttempt'].map((column) => <TableHeaderCell key={column}>{t(`monitoring.columns.${column}`)}</TableHeaderCell>)}
              </TableRow></TableHeader>
              <TableBody>{monitoring.data?.systems.map((s) => <TableRow key={`${s.system}/${s.job}`}>
                <TableCell><Text weight="semibold">{systemName(t, s.system)}</Text><Text block className={styles.muted}>{t(`integrations.jobNames.${s.job}`, { defaultValue: s.job })}</Text></TableCell>
                <TableCell className={s.lastSucceededAt ? table.nowrap : styles.muted}>{s.lastSucceededAt ? formatDateTime(s.lastSucceededAt) : t('monitoring.noSuccess')}</TableCell>
                <TableCell><Badge appearance="tint" color={freshnessColor[s.freshness] ?? 'subtle'}>{t(`monitoring.freshness.${s.freshness}`)}</Badge>
                  <Text block className={mergeClasses(styles.muted, styles.cellLine)}>{t('monitoring.age', { age: s.ageMinutes === null ? '—' : span(Math.floor(s.ageMinutes)), threshold: span(s.thresholdMinutes) })}</Text></TableCell>
                <TableCell><span className={table.nowrap}>{formatDateTime(s.lastRunAt)}</span><Text block className={styles.muted}>{s.lastRunStatus ? t(`integrations.status.${s.lastRunStatus}`, { defaultValue: s.lastRunStatus }) : '—'}</Text></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </ScrollRegion>
          <Toolbar label={t('monitoring.filtersLabel')} className={styles.filters}
            end={<Button onClick={() => { setFilters(emptyFilters); setSavedName(''); }}>{t('monitoring.reset')}</Button>}>
            <FilterField label={t('monitoring.columns.category')}><Select value={filters.category} onChange={(_, d) => changeFilter('category', d.value)}>
              <option value="">{t('monitoring.allOf.category')}</option>{['Integration', 'Financial', 'Pause'].map((c) => <option key={c} value={c}>{t(`monitoring.categories.${c}`)}</option>)}
            </Select></FilterField>
            <FilterField label={t('monitoring.columns.source')}><Select value={filters.source} onChange={(_, d) => changeFilter('source', d.value)}>
              <option value="">{t('monitoring.allOf.source')}</option>{[...new Set(exceptions.map((e) => e.source))].sort().map((s) => <option key={s} value={s}>{systemName(t, s)}</option>)}
            </Select></FilterField>
            <FilterField label={t('monitoring.columns.status')}><Select value={filters.status} onChange={(_, d) => changeFilter('status', d.value)}>
              <option value="">{t('monitoring.allOf.status')}</option>{['Open', 'InProgress', 'Resolved'].map((s) => <option key={s} value={s}>{t(`monitoring.status.${s}`)}</option>)}
            </Select></FilterField>
            <FilterField label={t('monitoring.columns.owner')}><Select value={filters.owner} onChange={(_, d) => changeFilter('owner', d.value)}>
              <option value="">{t('monitoring.allOf.owner')}</option><option value="Mine">{t('monitoring.mine')}</option><option value="Unassigned">{t('monitoring.unassigned')}</option>
            </Select></FilterField>
          </Toolbar>
          {/* Saved views: the same filters under a name of the person's own, set apart from the filters by a hairline. */}
          <Toolbar label={t('monitoring.views')} className={styles.views}>
            <FilterField label={t('monitoring.views')}><Select value={savedName} onChange={(_, d) => {
              setSavedName(d.value); const view = views.find((v) => v.name === d.value); if (view) setFilters(view.filters);
            }}><option value="">{t('monitoring.chooseView')}</option>{views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</Select></FilterField>
            <Button disabled={!savedName} onClick={() => { if (saveViews(views.filter((v) => v.name !== savedName))) setSavedName(''); }}>{t('monitoring.deleteView')}</Button>
            <FilterField label={t('monitoring.viewName')}><Input maxLength={40} placeholder={t('monitoring.viewName')} value={viewName} onChange={(_, d) => setViewName(d.value)} /></FilterField>
            <Button disabled={!viewName.trim() || (views.length >= 10 && !views.some((v) => v.name === viewName.trim()))} onClick={() => {
              const name = viewName.trim(); if (saveViews([...views.filter((v) => v.name !== name), { name, filters }])) { setSavedName(name); setViewName(''); }
            }}>{t('monitoring.saveView')}</Button>
          </Toolbar>
          <Text className={styles.muted}>{t('monitoring.viewsHint')}</Text>
          {storageFailed && <MessageBar intent="error"><MessageBarBody>{t('monitoring.storageFailed')}</MessageBarBody></MessageBar>}
          <Text className={styles.count}>{t('monitoring.shown', { shown: shown.length, total, count: total })}</Text>
          {recoveredTotal > recoveredShown && <Text className={styles.muted}>{t('monitoring.recoveredLimit', { shown: recoveredShown, total: recoveredTotal })}</Text>}
          {shown.length === 0 ? <EmptyState message={t('monitoring.empty')} icon={<Gauge24Regular />} /> : <ScrollTable className={table.inset}>
            <Table size="small" className={mergeClasses(table.min880, table.roomy)} aria-label={t('monitoring.exceptions')}>
              <TableHeader><TableRow>{['source', 'category', 'impact', 'owner', 'status', 'comment'].map((c) => <TableHeaderCell key={c}>{t(`monitoring.columns.${c}`)}</TableHeaderCell>)}<TableHeaderCell className={table.actionCol} aria-label={t('monitoring.edit')} /></TableRow></TableHeader>
              <TableBody>{shown.map((e) => <TableRow key={e.key}>
                <TableCell><Text weight="semibold">{systemName(t, e.source)}</Text><Text block>{kindName(e.kind)}</Text>{!e.active && <Text block>{t('monitoring.recovered')}</Text>}<Text block className={styles.muted}>{t('monitoring.detected', { at: formatDateTime(e.detectedAt) })}</Text></TableCell>
                <TableCell>{t(`monitoring.categories.${e.category}`)}</TableCell>
                <TableCell><Text>{t(`monitoring.impacts.${e.impact}`, { defaultValue: t('monitoring.impacts.Other') })}</Text><Text block className={styles.muted}>{t('monitoring.affected', { count: e.count })}</Text></TableCell>
                <TableCell><Owner exception={e} /></TableCell>
                <TableCell><Badge appearance="tint" color={triageColor[e.triage.status] ?? 'subtle'}>{t(`monitoring.status.${e.triage.status}`)}</Badge></TableCell>
                <TableCell className={styles.comment}>{e.triage.comment || '—'}</TableCell>
                <TableCell><Button {...restoreFocusTarget} size="small" onClick={() => setEditing(e)}>{t('monitoring.edit')}</Button></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </ScrollTable>}
        </>}
      </div>
      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}><DialogSurface>
        {shownException && <TriageForm exception={shownException} onClose={() => setEditing(null)} />}
      </DialogSurface></Dialog>
    </Panel>
  );
}

/** The owner of a review as a person cell; an unassigned review says so in quiet text. */
function Owner({ exception }: { exception: MonitoringException }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const user = useCurrentUser();
  const name = exception.triage.ownerName ?? (exception.triage.ownerId === user.id ? user.displayName : exception.triage.ownerId);
  return name ? <PersonCell name={name} size={24} /> : <Text className={styles.muted}>{t('monitoring.unassigned')}</Text>;
}

function TriageForm({ exception, onClose }: { exception: MonitoringException; onClose: () => void }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const ownerLabel = useId();
  const user = useCurrentUser();
  const [owner, setOwner] = useState<UserRef | null>(exception.triage.ownerId ? {
    id: exception.triage.ownerId, displayName: exception.triage.ownerName ?? (exception.triage.ownerId === user.id ? user.displayName : exception.triage.ownerId),
  } : null);
  const [status, setStatus] = useState<TriageStatus>(exception.triage.status);
  const [comment, setComment] = useState(exception.triage.comment ?? '');
  const update = useTriage();
  return <form onSubmit={(event) => { event.preventDefault(); if (!update.isPending) update.mutate({
    key: exception.key, ownerId: owner?.id ?? null, ownerName: owner?.displayName ?? null, status, comment: comment.trim() || null, etag: exception.triage.etag,
  }, { onSuccess: onClose }); }}>
    <DialogBody><DialogTitle>{t('monitoring.editTitle', { source: systemName(t, exception.source) })}</DialogTitle>
      <DialogContent className={styles.dialog}>
        {update.error && <MessageBar intent="error"><MessageBarBody>{errorMessage(update.error, t)}</MessageBarBody></MessageBar>}
        <Text weight="semibold">{t(`monitoring.kinds.${exception.kind}`, { defaultValue: t('monitoring.kinds.Other') })}</Text>
        <Text>{t(exception.active ? 'monitoring.resolveAfterRecovery' : 'monitoring.recovered')}</Text>
        <Text>{t(`monitoring.recovery.${exception.kind}`, { defaultValue: t('monitoring.recovery.Other') })}</Text>
        <Text className={styles.muted}>{t('monitoring.runbook', { reference: exception.runbook })}</Text>
        <Text>{t('monitoring.lastSuccess', { at: exception.lastSucceededAt ? formatDateTime(exception.lastSucceededAt) : t('monitoring.noSuccess') })}</Text>
        <Field label={{ children: t('monitoring.columns.owner'), id: ownerLabel }}><UserPicker key={owner?.id ?? 'unassigned'} value={owner} onChange={setOwner} aria-labelledby={ownerLabel} /></Field>
        <Button onClick={() => setOwner({ id: user.id, displayName: user.displayName })}>{t('monitoring.assignMe')}</Button>
        <Field label={t('monitoring.columns.status')}><Select value={status} onChange={(_, d) => setStatus(d.value as TriageStatus)}>{['Open', 'InProgress', 'Resolved'].map((s) => <option key={s} value={s} disabled={s === 'Resolved' && exception.active}>{t(`monitoring.status.${s}`)}</option>)}</Select></Field>
        <Field label={t('monitoring.columns.comment')} hint={t('monitoring.commentHint')}><Textarea value={comment} maxLength={2000} rows={4} onChange={(_, d) => setComment(d.value)} /></Field>
      </DialogContent>
      <DialogActions><Button onClick={onClose} disabled={update.isPending}>{t('common.cancel')}</Button><Button type="submit" appearance="primary" disabled={update.isPending}>{t('common.save')}</Button></DialogActions>
    </DialogBody>
  </form>;
}
