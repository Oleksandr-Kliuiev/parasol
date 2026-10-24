import { useEffect, useState } from 'react';
import { Toaster } from '@fluentui/react-components';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { TOASTER_ID } from '../../app/toaster';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { OperationsTab } from './OperationsTab';
import { syntheticAlert } from '../../test/alerts';
import type { Alert, Device, ServiceSummary, Ticket, TicketRequest } from './types';

export const kinds = ['summary', 'tickets', 'devices', 'alerts', 'ticket-requests'] as const;
export type Kind = typeof kinds[number];
export const names: Record<Kind, string> = { summary: 'Saved service summary', tickets: 'Tickets', devices: 'Devices', alerts: 'Open alerts', 'ticket-requests': 'Ticket requests' };
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export const empty = () => json({ items: [], nextCursor: null, totalCount: 0 });
export const summary: ServiceSummary = { openTickets: 3, ticketsLast90Days: 8, devices: { Workstation: 2 }, devicesOnline: 1, criticalAlerts: 1, warningAlerts: 2, lastSyncedAt: '2025-01-02T10:30:00Z',
  reads: (['tickets', 'alerts', 'devices'] as const).map((source) => ({ source, system: 'atera', startedAt: '2025-01-02T10:30:00Z', complete: true, late: false })) };
export const device = (id = 'one'): Device => ({ id, machineName: `Synthetic PC ${id}`, type: 'Workstation', os: 'Synthetic OS', online: true, lastSeenAt: null, url: null, removedAt: null, openAlerts: 0 });
export const ticket = (id = 'one'): Ticket => ({ id, title: `Synthetic ticket ${id}`, externalId: 42, organizationId: 'o1', organizationName: null, contactId: null, contactName: null,
  status: 'Open', isOpen: true, priority: null, type: null, technicianName: null, createdAt: '2026-10-16T10:00:00Z', resolvedAt: null, lastActivityAt: null, url: null });
export const alert = (id = 'one'): Alert => syntheticAlert({ id, title: `Synthetic alert ${id}`, deviceName: 'Synthetic PC', createdAt: '2026-10-16T10:00:00Z' });
export const request = (status: TicketRequest['status'] = 'Failed', id = 'one'): TicketRequest => ({ id, title: `Synthetic request ${id}`, status, externalTicketId: null, url: null, error: 'Synthetic rejection', createdAt: '2026-10-16T10:00:00Z' });
export const pageResult = (items: unknown[], nextCursor: string | null = null, totalCount = items.length) => json({ items, nextCursor, totalCount });
export const kindOf = (url: string): Kind | null => {
  const path = new URL(url, 'https://synthetic.invalid').pathname;
  return kinds.find(kind => path.endsWith(`/${kind}`)) ?? null;
};
export function answer(kind: Kind, populated = true): Response {
  if (kind === 'summary') return json(summary);
  if (!populated) return empty();
  return pageResult(kind === 'tickets' ? [ticket()] : kind === 'devices' ? [device()] : kind === 'alerts' ? [alert()] : [request()]);
}
export const failure = 'Saved data could not be read. No previous data is shown. Try again or refresh saved data.';
export const refreshName = 'Refresh saved data';
export const allowed = ['service.read', 'service.write'];
export function renderService(permissions = allowed, capture?: (client: QueryClient) => void) {
  function Host() {
    const [user, setUser] = useState(testUser(permissions)); const [organization, setOrganization] = useState('o1'); const client = useQueryClient();
    useEffect(() => { capture?.(client); }, [client]);
    return <CurrentUserContext.Provider value={user}><Toaster toasterId={TOASTER_ID} />
      <button onClick={() => setUser({ ...user, id: 'employee-two' })}>Change employee</button>
      <button onClick={() => setUser({ ...user, permissions: ['service.read'] })}>Drop write</button>
      <button onClick={() => setUser({ ...user, permissions: [] })}>Drop read</button>
      <button onClick={() => setOrganization('o2')}>Change customer</button>
      <OperationsTab organizationId={organization} />
    </CurrentUserContext.Provider>;
  }
  return renderRoutes([page(<Host />)], '/', testUser(permissions));
}
