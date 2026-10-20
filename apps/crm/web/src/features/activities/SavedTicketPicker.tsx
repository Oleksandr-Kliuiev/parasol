import { useEffect, useState } from 'react';
import { Button, Field, Input, Radio, RadioGroup, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime } from '../../shared/utils/format';
import { useSavedServiceList } from '../service/useSavedServiceList';
import type { TicketWorkRef } from './taskTicketTypes';

const useStyles = makeStyles({
  list: { maxHeight: '40vh', overflowY: 'auto', padding: tokens.spacingHorizontalXS },
  details: { display: 'grid', overflowWrap: 'anywhere', gap: tokens.spacingVerticalXXS },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS },
});

/** Filtering is explicitly limited to manually loaded saved pages. */
export function SavedTicketPicker({ organizationId, scope, revision, selectedId, onSelect, onInvalidate, disabled }: {
  organizationId: string; scope: string; revision: number; selectedId: string | null;
  onSelect: (ticket: TicketWorkRef) => void; onInvalidate: () => void; disabled: boolean;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const [filter, setFilter] = useState('');
  const tickets = useSavedServiceList<TicketWorkRef>(['task-work-tickets'], '/api/v1/service/work-tickets',
    { organizationId }, { owner: scope, revision }, 50);
  useEffect(() => { if (!tickets.available) onInvalidate(); }, [tickets.available, onInvalidate]);
  const needle = filter.trim().toLocaleLowerCase();
  const visible = tickets.items.filter(ticket => `${ticket.externalId} ${ticket.title}`.toLocaleLowerCase().includes(needle));
  return <section aria-label={t('taskTicket.choose')}>
    <Field label={t('taskTicket.filter')} hint={t('taskTicket.filterHint')}>
      <Input value={filter} onChange={(_, data) => setFilter(data.value)} disabled={disabled} />
    </Field>
    {tickets.checking && <Spinner size="small" label={t('taskTicket.loading')} />}
    {tickets.error && <ErrorState error={tickets.error} onRetry={tickets.refresh} />}
    {tickets.available && <>
      {tickets.items.length === 0 ? <Text role="status">{t('taskTicket.empty')}</Text>
        : visible.length === 0 ? <Text role="status">{t('taskTicket.noMatch')}</Text> :
          <RadioGroup className={styles.list} aria-label={t('taskTicket.choose')} value={selectedId ?? ''} disabled={disabled}
            onChange={(_, data) => { const ticket = tickets.items.find(item => item.id === data.value); if (ticket) onSelect(ticket); }}>
            {visible.map(ticket => <Radio key={ticket.id} value={ticket.id} aria-label={`#${ticket.externalId} · ${ticket.title}`} label={<span className={styles.details}>
              <Text weight="semibold">#{ticket.externalId} · {ticket.title}</Text>
              <Text size={200}>{ticket.status} · {t('taskTicket.imported', { at: formatDateTime(ticket.importedAt) })}</Text>
            </span>} />)}
          </RadioGroup>}
      <div className={styles.footer}>
        {tickets.total !== null && <Text aria-live="polite">{t('common.shownOf', { shown: tickets.items.length, total: tickets.total })}</Text>}
        {tickets.hasNextPage && <Button disabled={tickets.isFetchingNextPage || disabled} disabledFocusable={tickets.isFetchingNextPage || disabled}
          onClick={() => void tickets.fetchNextPage()}>{t('common.loadMore')}</Button>}
      </div>
    </>}
  </section>;
}
