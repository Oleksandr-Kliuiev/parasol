import { useState } from 'react';
import { Link, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { History16Regular, History24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { FilterChips } from '../../shared/components/Toolbar';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { useFlushStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { systemName } from '../integrations/labels';
import { ActionDetailDialog } from './ActionDetailDialog';
import { useActionLog, type ActionLogFilters } from './api';
import { ActionStatusBadge } from './ActionStatusBadge';
import { kindName } from './actionText';
import type { VendorAction } from './types';

const useStyles = makeStyles({
  pad: { margin: 0, paddingLeft: '20px', paddingRight: '20px', paddingBottom: '16px', color: h.muted, fontSize: '13px', lineHeight: '20px',
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  // The title opens the action: a link-styled button with a 24 px hit box (WCAG 2.5.8), the words wrapping as needed.
  open: { textAlign: 'left', minHeight: '24px', fontWeight: 600, overflowWrap: 'anywhere' },
});

/** One action as a row: what and on what, who asked and when; the state on the right. */
export function ActionRow({ action, onOpen, showTarget = true }: { action: VendorAction; onOpen: () => void; showTarget?: boolean }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const title = showTarget ? `${kindName(t, action.system, action.kind)} · ${action.targetName}` : kindName(t, action.system, action.kind);
  return <RecordRow icon={<History16Regular />} tone={action.status === 'Uncertain' || action.status === 'Failed' ? 'ember' : 'neutral'}
    title={<Link {...restore} as="button" type="button" className={styles.open} onClick={onOpen}>{title}</Link>}
    meta={<RowMeta>
      {[action.requestedByName, showTarget ? action.organizationName : null, systemName(t, action.system)].filter(Boolean).join(' · ')}
      {' · '}<time dateTime={action.requestedAt} title={formatDateTime(action.requestedAt)}>{formatRelative(action.requestedAt)}</time>
    </RowMeta>}
    end={<ActionStatusBadge status={action.status} />} />;
}

/**
 * The action log on Connections (M39.1): every action asked of a vendor, newest first. An action without a clear outcome waits
 * for a person, so that filter carries its count; a row opens the action with its outcome and, when needed, the verdict.
 */
export function ActionLogPanel() {
  const { t } = useTranslation(); const styles = useStyles(); const flush = useFlushStyles();
  const [state, setState] = useState<'all' | 'attention' | 'waiting'>('all');
  const filters: ActionLogFilters = state === 'all' ? {} : { state };
  return <Panel title={t('actions.log.title')} icon={<History16Regular />} flush className={flush.panel}>
    <Text block className={styles.pad}>{t('actions.log.note')}</Text>
    <div className={styles.pad}>
      <ActionStateFilter value={state} onChange={setState} />
    </div>
    <ActionList key={state} filters={filters} empty={t(state === 'attention' ? 'actions.log.noneUncertain' : state === 'waiting' ? 'actions.log.noneWaiting' : 'actions.log.none')} />
  </Panel>;
}

/** The three views of the log; the counts come from the unfiltered log so they stay put while the person switches. */
function ActionStateFilter({ value, onChange }: { value: 'all' | 'attention' | 'waiting'; onChange: (value: 'all' | 'attention' | 'waiting') => void }) {
  const { t } = useTranslation();
  const counts = useActionLog({}, { limit: 1 });
  return <FilterChips label={t('actions.log.filter')} value={value} onChange={onChange} options={[
    { value: 'all', label: t('actions.log.all'), count: counts.total ?? undefined },
    { value: 'attention', label: t('actions.log.attention'), count: counts.isSuccess ? counts.uncertain : undefined },
    { value: 'waiting', label: t('actions.log.waiting'), count: counts.isSuccess ? counts.waiting : undefined },
  ]} />;
}

/** A page of actions with its footer; <c>showTarget</c> is off where the target is the page itself (a ticket's own actions). */
export function ActionList({ filters, empty, showTarget = true, limit }: { filters: ActionLogFilters; empty: string; showTarget?: boolean; limit?: number }) {
  const { t } = useTranslation(); const flush = useFlushStyles(); const styles = useStyles();
  const log = useActionLog(filters, { limit });
  const [open, setOpen] = useState<VendorAction | null>(null);
  return <>
    {log.isPending && <div className={styles.pad}><Spinner size="small" label={t('common.loading')} /></div>}
    {log.isError && <div className={styles.pad}><ErrorState error={log.error} onRetry={() => void log.refetch()} /></div>}
    {log.items.length > 0 && <ul className={flush.list}>{log.items.map((action) =>
      <ActionRow key={action.id} action={action} showTarget={showTarget} onOpen={() => setOpen(action)} />)}</ul>}
    {log.isSuccess && log.items.length === 0 && <div className={styles.pad}><EmptyState compact icon={<History24Regular />} message={empty} /></div>}
    <ListFooter shown={log.items.length} total={log.total} hasMore={log.hasNextPage} loading={log.isFetchingNextPage} onMore={() => void log.fetchNextPage()} />
    <ActionDetailDialog action={open} onClose={() => setOpen(null)} ticketShown={!showTarget} />
  </>;
}
