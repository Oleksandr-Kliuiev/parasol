import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, Link, SearchBox, Skeleton, SkeletonItem, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { ArrowClockwise20Regular, Headset16Regular, Headset24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Permissions, useCan, useCurrentUser } from '../../../auth/CurrentUserContext';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { PageHeader } from '../../../shared/components/PageHeader';
import { Panel } from '../../../shared/components/Panel';
import { FilterChips, FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import { useDebouncedValue } from '../../../shared/utils/useDebouncedValue';
import { RecordRow, RowMeta } from '../../billing/RecordRow';
import { useFlushStyles } from '../../billing/flushStyles';
import { ForbiddenPage } from '../../errors/ForbiddenPage';
import { ServiceReadLine } from '../ServiceReadLine';
import type { Ticket } from '../types';
import { useServiceReads, useTicketQueue } from './api';
import { TicketPanel } from './TicketPanel';

const useStyles = makeStyles({
  totals: { display: 'block', marginBottom: '12px', color: h.muted, fontSize: '13px', lineHeight: '19px', fontVariantNumeric: 'tabular-nums' },
  // The title opens the ticket: a link-styled button with a 24 px hit box (WCAG 2.5.8) that wraps like text.
  open: { textAlign: 'left', minHeight: '24px', fontWeight: 600, overflowWrap: 'anywhere' },
  end: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' },
});

/** Tickets across customers (M39.2, Work → Tickets): Atera stays the system of record, the CRM is where they are worked. */
export function TicketsPage() {
  const user = useCurrentUser();
  const canService = useCan(Permissions.serviceRead);
  if (!canService) return <ForbiddenPage />;
  // A new person or new rights start with a new list: no rows or panel of the previous reader stay on screen.
  return <Tickets key={`${user.id}:${[...user.permissions].sort().join(',')}`} />;
}

function Tickets() {
  const { t } = useTranslation(); const styles = useStyles(); const flush = useFlushStyles();
  const [params, setParams] = useSearchParams(); const location = useLocation(); const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const all = params.get('show') === 'all';
  const mine = params.get('mine') === '1';
  const queue = useTicketQueue({ openOnly: !all, mine, search: debounced });
  const reads = useServiceReads();
  const ticketReads = reads.data?.filter((read) => read.source === 'tickets' || read.source === 'conversations');

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  // One ticket in a side panel with its own address (?ticket=), so Back closes it and other pages can link to it.
  const peekId = params.get('ticket');
  const open = (ticket: Ticket) => { const next = new URLSearchParams(params); next.set('ticket', ticket.id); setParams(next, { state: { ticketPeek: true } }); };
  const close = () => {
    if ((location.state as { ticketPeek?: boolean } | null)?.ticketPeek) { void navigate(-1); return; }
    setParam('ticket', null);
  };
  const refreshing = queue.isFetching && !queue.isFetchingNextPage;
  const filtered = mine || debounced !== '';

  return <>
    <PageHeader title={t('tickets.title')} subtitle={t(all ? 'tickets.subtitleAll' : 'tickets.subtitle')}
      meta={ticketReads && !reads.isFetching && !refreshing && <ServiceReadLine reads={ticketReads} />}
      actions={<Button icon={<ArrowClockwise20Regular />} aria-label={t('tickets.refresh')} disabled={refreshing} disabledFocusable={refreshing}
        onClick={() => { void queue.refetch(); void reads.refetch(); }}>{t('common.refresh')}</Button>} />
    <Toolbar label={t('tickets.filters')}>
      <FilterField kind="search" label={t('tickets.search')}>
        <SearchBox value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('tickets.search')} />
      </FilterField>
      <FilterChips<'open' | 'all'> label={t('tickets.stateLabel')} value={all ? 'all' : 'open'} onChange={(value) => setParam('show', value === 'all' ? 'all' : null)}
        options={[{ value: 'open', label: t('tickets.show.open') }, { value: 'all', label: t('tickets.show.all') }]} />
      <FilterChips<'everyone' | 'mine'> label={t('tickets.whoLabel')} value={mine ? 'mine' : 'everyone'} onChange={(value) => setParam('mine', value === 'mine' ? '1' : null)}
        options={[{ value: 'everyone', label: t('tickets.who.everyone') }, { value: 'mine', label: t('tickets.who.mine') }]} />
    </Toolbar>
    {queue.error ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} /> : queue.isPending
      ? <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>
      : <>
        {queue.total !== null && queue.total > 0 && <Text className={styles.totals} role="status">{t(all ? 'tickets.totalsAll' : 'tickets.totals', { count: queue.total })}</Text>}
        <Panel title={t('tickets.listTitle')} icon={<Headset16Regular />} flush className={flush.panel}>
          {queue.items.length > 0
            ? <ul className={flush.list}>{queue.items.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} onOpen={() => open(ticket)} />)}</ul>
            : <EmptyState icon={<Headset24Regular />} message={t(filtered ? 'tickets.emptyFiltered' : all ? 'tickets.emptyAll' : 'tickets.empty')}
              action={filtered && <Button onClick={() => { setSearch(''); setParam('mine', null); }}>{t('tickets.clearFilters')}</Button>} />}
          <ListFooter shown={queue.items.length} total={queue.total} hasMore={Boolean(queue.hasNextPage)} loading={queue.isFetchingNextPage}
            onMore={() => void queue.fetchNextPage()} />
        </Panel>
      </>}
    <TicketPanel ticketId={peekId} onClose={close} />
  </>;
}

/** One ticket: its number and title open the panel; the customer, the person and the technician under it; status and priority at the end. */
function TicketRow({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const at = ticket.lastActivityAt ?? ticket.createdAt;
  return <RecordRow icon={<Headset16Regular />} tone={ticket.isOpen ? 'iris' : 'neutral'}
    title={<Link {...restore} as="button" type="button" className={styles.open} onClick={onOpen}>{`#${ticket.externalId} ${ticket.title}`}</Link>}
    meta={<RowMeta>
      {[ticket.organizationName, ticket.contactName, ticket.technicianName ?? t('tickets.fields.noTechnician')].filter(Boolean).join(' · ')}
      {' · '}<time dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time>
    </RowMeta>}
    end={<span className={styles.end}>
      {ticket.priority && <Badge appearance="outline" color={ticket.priority === 'Critical' || ticket.priority === 'High' ? 'danger' : 'informative'}>
        {t(`tickets.priorities.${ticket.priority}`, { defaultValue: ticket.priority })}</Badge>}
      <Badge appearance="tint" color={ticket.isOpen ? 'informative' : 'subtle'}>{t(`tickets.statuses.${ticket.status}`, { defaultValue: ticket.status })}</Badge>
    </span>} />;
}
