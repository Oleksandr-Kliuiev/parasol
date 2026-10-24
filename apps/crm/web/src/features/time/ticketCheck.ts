import { useQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { PagedResult } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import type { Ticket } from '../service/types';

/**
 * What Parasoll knows of the ticket number typed in the time form (M39): a saved ticket of the chosen customer (`found`), none
 * (`missing`), or nothing to say yet (`idle` without a number or customer, `checking` while typing or reading, `unknown` when it
 * cannot be read). Only a found ticket can take the hours in Atera.
 */
export type TicketCheck =
  | { state: 'idle' | 'checking' | 'unknown' | 'missing'; ticket?: undefined }
  | { state: 'found'; ticket: Ticket };

/** Tickets are kept far longer than the list's 90 days: an entry may belong to an old closed one. */
const CHECK_DAYS = 3650;

export function useTicketCheck(organizationId: string | null, number: number | null, enabled = true): TicketCheck {
  const canRead = useCan(Permissions.serviceRead);
  const settled = useDebouncedValue(number);
  const ready = enabled && canRead && organizationId !== null && number !== null;
  const read = useQuery({
    queryKey: ['time', 'ticket-check', organizationId, settled],
    enabled: ready && settled === number,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => (await api.get<PagedResult<Ticket>>(
      `/api/v1/service/tickets${query({ organizationId: organizationId!, search: String(settled), days: CHECK_DAYS, limit: 5 })}`, signal)).data,
  });
  if (!enabled || organizationId === null || number === null) return { state: 'idle' };
  if (!canRead) return { state: 'unknown' };
  if (settled !== number || read.isFetching) return { state: 'checking' };
  if (read.isError) return { state: 'unknown' };
  const ticket = read.data?.items.find((item) => item.externalId === number && item.organizationId === organizationId);
  return ticket ? { state: 'found', ticket } : { state: read.isSuccess ? 'missing' : 'checking' };
}
