import { useRef, useState } from 'react';
import { Badge, Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, Link, OverlayDrawer, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { Dismiss24Regular, Open16Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { AppLink } from '../../../shared/components/AppLink';
import { ErrorState } from '../../../shared/components/ErrorState';
import { DetailList } from '../../../shared/components/Panel';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import { safeHttpUrl } from '../../../shared/utils/safeUrl';
import { useAction } from '../../actions/api';
import { ActionDetailDialog } from '../../actions/ActionDetailDialog';
import { ActionDialog } from '../../actions/ActionDialog';
import { ActionList } from '../../actions/ActionLog';
import type { VendorAction } from '../../actions/types';
import { sourceName } from '../alerts/alertText';
import { ServiceReadLine } from '../ServiceReadLine';
import type { TicketDetail } from '../types';
import { useTicket } from './api';
import { TicketActionsBar } from './TicketActionsBar';
import { TicketConversation } from './TicketConversation';
import type { TicketActionAsk } from './ticketActions';

const useStyles = makeStyles({
  // A side panel beside the list, as the alert panel: the person keeps their place.
  drawer: { width: 'min(560px, 100vw)' },
  body: { display: 'grid', gap: '20px', alignContent: 'start', paddingBottom: '24px', minWidth: 0 },
  facts: { gridTemplateColumns: 'minmax(0, 120px) minmax(0, 1fr)' },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  source: { display: 'grid', gap: '2px', justifyItems: 'start' },
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  log: { marginLeft: '-20px', marginRight: '-20px', '@media (max-width: 600px)': { marginLeft: '-16px', marginRight: '-16px' } },
});

/**
 * One ticket in a side panel (M39.2): what Atera said at the last read, how fresh that is, the changes a person can make, the
 * conversation with its answer box, and the actions already asked for this ticket. The address holds the ticket (`?ticket=`), and a
 * notice about an action adds it (`&action=`): its card opens over the ticket, where the person records what they found.
 */
export function TicketPanel({ ticketId, actionId = null, onActionClose, onClose }: {
  ticketId: string | null; actionId?: string | null; onActionClose?: () => void; onClose: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles();
  const read = useTicket(ticketId);
  const ticket = ticketId !== null && !read.isFetching ? read.data : undefined;
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const title = ticket ? `#${ticket.externalId} ${ticket.title}` : t('tickets.panel.title');
  return <OverlayDrawer className={styles.drawer} position="end" open={ticketId !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }} aria-label={title}>
    <DrawerHeader>
      <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label={t('common.close')} onClick={onClose} />}>{title}</DrawerHeaderTitle>
    </DrawerHeader>
    <DrawerBody className={styles.body}>
      {read.isFetching && !read.data && <Spinner size="small" label={t('tickets.panel.loading')} />}
      {!read.isFetching && read.isError && (missing
        ? <Text block role="status">{t('tickets.panel.notFound')}</Text>
        : <ErrorState error={read.error} onRetry={() => void read.refetch()} />)}
      {(ticket ?? read.data) && <TicketBody ticket={(ticket ?? read.data)!} actionId={actionId} onActionClose={onActionClose} onClose={onClose} />}
    </DrawerBody>
  </OverlayDrawer>;
}

function TicketBody({ ticket, actionId, onActionClose, onClose }: {
  ticket: TicketDetail; actionId: string | null; onActionClose?: () => void; onClose: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient();
  const linked = useAction(actionId).data ?? null;
  const canWrite = useCan(Permissions.serviceWrite);
  const [ask, setAsk] = useState<TicketActionAsk | null>(null);
  const bar = useRef<HTMLDivElement>(null); const asking = useRef(false);
  const link = ticket.url ? safeHttpUrl(ticket.url) : undefined;
  const openAsk = (next: TicketActionAsk) => { asking.current = true; setAsk(next); };
  // The button that asked takes focus back when the confirmation closes. Close ticket is gone once the ticket is closed: then
  // focus stays in the panel, on the first change it offers, never on the page behind — unless the next confirmation is open.
  const closeAsk = () => {
    asking.current = false;
    setAsk(null);
    window.setTimeout(() => {
      if (!asking.current && (document.activeElement === null || document.activeElement === document.body)) bar.current?.querySelector<HTMLElement>('button')?.focus();
    }, 400);
  };
  // A changed ticket is read again with its list and the Drift tab behind the panel; the action log reads itself.
  const finished = (action: VendorAction) => {
    ask?.onFinished?.(action);
    if (action.status === 'Succeeded' || action.status === 'Skipped') {
      void client.invalidateQueries({ queryKey: ['tickets'] });
      void client.invalidateQueries({ queryKey: ['service', 'tickets'] });
    }
  };

  return <>
    <DetailList className={styles.facts} items={[
      { label: t('tickets.fields.status'), value: <Badge appearance="tint" color={ticket.isOpen ? 'informative' : 'subtle'}>{t(`tickets.statuses.${ticket.status}`, { defaultValue: ticket.status })}</Badge> },
      ...(ticket.priority ? [{ label: t('tickets.fields.priority'), value: t(`tickets.priorities.${ticket.priority}`, { defaultValue: ticket.priority }) }] : []),
      { label: t('tickets.fields.customer'), value: <AppLink to={`/organizations/${ticket.organizationId}?tab=drift`} onClick={onClose}>
        {ticket.organizationName ?? t('tickets.fields.unknownCustomer')}</AppLink> },
      ...(ticket.contactName || ticket.endUserEmail ? [{ label: t('tickets.fields.contact'), value: [ticket.contactName, ticket.endUserEmail].filter(Boolean).join(' · ') }] : []),
      { label: t('tickets.fields.technician'), value: ticket.technicianName ?? t('tickets.fields.noTechnician') },
      { label: t('tickets.fields.created'), value: <>{formatDateTime(ticket.createdAt)} · <time dateTime={ticket.createdAt}>{formatRelative(ticket.createdAt)}</time></> },
      ...(ticket.resolvedAt ? [{ label: t('tickets.fields.resolved'), value: formatDateTime(ticket.resolvedAt) }] : []),
      { label: t('tickets.fields.source'), value: <span className={styles.source}>
        <span>{sourceName(t, ticket.system)}</span>
        {link && <Link href={link} target="_blank" rel="noopener noreferrer" className={styles.external}>
          {t('tickets.panel.openInSource', { name: sourceName(t, ticket.system) })}<Open16Regular aria-hidden /></Link>}
        {/* The conversation below says when this ticket's messages were read: the fact is said once. */}
        <ServiceReadLine reads={[ticket.ticketsRead]} />
      </span> },
    ]} />
    {canWrite && <TicketActionsBar ticket={ticket} onAsk={openAsk} groupRef={bar} />}
    <TicketConversation ticket={ticket} canWrite={canWrite} onAsk={openAsk} />
    <section className={styles.section} aria-labelledby={`ticket-actions-${ticket.id}`}>
      <h3 id={`ticket-actions-${ticket.id}`} className={styles.heading}>{t('tickets.panel.actions')}</h3>
      <div className={styles.log}>
        <ActionList filters={{ targetType: 'ticket', targetId: String(ticket.externalId) }} showTarget={false} limit={5} empty={t('tickets.panel.noActions')} />
      </div>
    </section>
    <ActionDialog request={ask?.request ?? null} title={ask?.title ?? ''} confirm={ask?.confirm ?? ''} details={ask?.details}
      onClose={closeAsk} onAccepted={ask?.onAccepted} onFinished={finished} />
    <ActionDetailDialog action={actionId !== null && linked?.id === actionId ? linked : null} onClose={() => onActionClose?.()}
      ticketShown={linked?.ticketId === ticket.id} />
  </>;
}
