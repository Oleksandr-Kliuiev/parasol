import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { usePagedList } from '../../../api/paging';
import type { AteraTechnician, ServiceSourceRead, Ticket, TicketComment, TicketDetail } from '../types';

const BASE = '/api/v1/service';

export const ticketKeys = {
  all: ['tickets'] as const,
  queue: (filters: TicketQueueFilters) => ['tickets', 'queue', filters] as const,
  one: (id: string) => ['tickets', 'one', id] as const,
  comments: (id: string) => ['tickets', 'comments', id] as const,
  reads: ['tickets', 'reads'] as const,
  technicians: ['tickets', 'technicians'] as const,
};

export interface TicketQueueFilters {
  openOnly?: boolean;
  mine?: boolean;
  search?: string;
  organizationId?: string | null;
}

/**
 * Tickets across customers (M39.2): open first, then the most recently active, a page at a time with the count of all (DEV-12). The
 * search finds a title, a number or the contact; a customer narrows the queue to its tickets. A new search or filter is read with the
 * previous rows kept in place, so a row someone is clicking does not vanish while the answer is on its way.
 */
export function useTicketQueue(filters: TicketQueueFilters) {
  return usePagedList<Ticket>(ticketKeys.queue(filters), `${BASE}/tickets`, {
    openOnly: filters.openOnly || undefined, mine: filters.mine || undefined, search: filters.search || undefined,
    organizationId: filters.organizationId || undefined,
  }, { limit: 25, keepPrevious: true });
}

/** How fresh each kind of service data is; read with the list it stands beside. */
export function useServiceReads(enabled = true) {
  return useQuery({
    queryKey: ticketKeys.reads, enabled, staleTime: 0,
    queryFn: async ({ signal }) => (await api.get<ServiceSourceRead[]>(`${BASE}/reads`, signal)).data,
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ticketKeys.one(id ?? ''), enabled: id !== null, staleTime: 0, retry: false,
    queryFn: async ({ signal }) => (await api.get<TicketDetail>(`${BASE}/tickets/${id}`, signal)).data,
  });
}

/** The conversation, newest first a page at a time; the panel shows it oldest first and loads earlier messages on request. */
export function useTicketComments(id: string | null) {
  return usePagedList<TicketComment>(ticketKeys.comments(id ?? ''), `${BASE}/tickets/${id}/comments`, {}, { enabled: id !== null, limit: 20 });
}

/** The technicians a ticket can be given to; read once the person opens the choice. */
export function useAteraTechnicians(enabled: boolean) {
  return useQuery({
    queryKey: ticketKeys.technicians, enabled, staleTime: 60_000,
    queryFn: async ({ signal }) => (await api.get<AteraTechnician[]>('/api/v1/integrations/atera/technicians', signal)).data,
  });
}
