import { useState, type Ref } from 'react';
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Spinner, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { CheckmarkCircle16Regular, ChevronDown16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { TicketDetail } from '../types';
import { useAteraTechnicians } from './api';
import { ticketPriorities, ticketRequest, ticketStatuses, type TicketActionAsk } from './ticketActions';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
});

/**
 * The changes a person makes to a ticket from its panel (M39.2): status, priority, technician and closing. Each choice opens the one
 * action confirmation with the server's preview; nothing changes in Atera before it is confirmed there.
 */
export function TicketActionsBar({ ticket, onAsk, groupRef }: { ticket: TicketDetail; onAsk: (ask: TicketActionAsk) => void; groupRef?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation(); const styles = useStyles();
  // Each button that opens the confirmation gets focus back when it closes, as the alert panel's buttons do.
  const restore = useRestoreFocusTarget();
  const [technicianMenu, setTechnicianMenu] = useState(false);
  const technicians = useAteraTechnicians(technicianMenu);
  const number = `#${ticket.externalId}`;
  const ask = (kind: string, parameters: Record<string, unknown>, title: string, confirm: string) =>
    onAsk({ request: ticketRequest(ticket, kind, parameters), title, confirm });

  return <div ref={groupRef} className={styles.bar} role="group" aria-label={t('tickets.actions.label')}>
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button {...restore} size="small" icon={<ChevronDown16Regular />} iconPosition="after">{t('tickets.actions.status')}</Button>
      </MenuTrigger>
      <MenuPopover><MenuList>
        {/* Closed is Close ticket's: one way to close a ticket. */}
        {ticketStatuses.filter((status) => status !== 'Closed' && status.toLowerCase() !== ticket.status.toLowerCase()).map((status) => (
          <MenuItem key={status} onClick={() => ask('ticket.status', { status }, t('tickets.actions.statusTitle', { number, status: t(`tickets.statuses.${status}`) }),
            t('tickets.actions.statusConfirm', { status: t(`tickets.statuses.${status}`) }))}>
            {t(`tickets.statuses.${status}`)}
          </MenuItem>))}
      </MenuList></MenuPopover>
    </Menu>
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button {...restore} size="small" icon={<ChevronDown16Regular />} iconPosition="after">{t('tickets.actions.priority')}</Button>
      </MenuTrigger>
      <MenuPopover><MenuList>
        {ticketPriorities.filter((priority) => priority.toLowerCase() !== (ticket.priority ?? '').toLowerCase()).map((priority) => (
          <MenuItem key={priority} onClick={() => ask('ticket.priority', { priority }, t('tickets.actions.priorityTitle', { number }),
            t('tickets.actions.priorityConfirm', { priority: t(`tickets.priorities.${priority}`) }))}>
            {t(`tickets.priorities.${priority}`)}
          </MenuItem>))}
      </MenuList></MenuPopover>
    </Menu>
    <Menu open={technicianMenu} onOpenChange={(_, data) => setTechnicianMenu(data.open)}>
      <MenuTrigger disableButtonEnhancement>
        <Button {...restore} size="small" icon={<ChevronDown16Regular />} iconPosition="after">{t('tickets.actions.technician')}</Button>
      </MenuTrigger>
      <MenuPopover><MenuList>
        {technicians.isFetching && <MenuItem disabled><Spinner size="extra-tiny" label={t('common.loading')} /></MenuItem>}
        {technicians.isError && <MenuItem disabled>{t('tickets.actions.techniciansFailed')}</MenuItem>}
        {technicians.isSuccess && !technicians.isFetching && technicians.data.length === 0 && <MenuItem disabled>{t('tickets.actions.noTechnicians')}</MenuItem>}
        {technicians.isSuccess && !technicians.isFetching && technicians.data.map((technician) => (
          <MenuItem key={technician.id} secondaryContent={technician.email ?? undefined}
            onClick={() => ask('ticket.technician', { technicianId: technician.id }, t('tickets.actions.technicianTitle', { number }),
              t('tickets.actions.technicianConfirm', { name: technician.name }))}>
            {technician.name}
          </MenuItem>))}
      </MenuList></MenuPopover>
    </Menu>
    {ticket.status.toLowerCase() !== 'closed' && <Button {...restore} size="small" icon={<CheckmarkCircle16Regular />}
      onClick={() => ask('ticket.close', {}, t('tickets.actions.closeTitle', { number }), t('tickets.actions.closeConfirm'))}>
      {t('tickets.actions.close')}
    </Button>}
  </div>;
}
