import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { Alert, Device, ServiceSummary, SlaReport, Ticket, TicketOptions, TicketRequest } from './types';

const BASE = '/api/v1/service';

export const serviceKeys = {
  all: ['service'] as const,
  summary: (organizationId: string) => ['service', 'summary', organizationId] as const,
  tickets: (filters: object) => ['service', 'tickets', filters] as const,
  devices: (organizationId: string) => ['service', 'devices', organizationId] as const,
  alerts: (organizationId: string) => ['service', 'alerts', organizationId] as const,
  requests: (organizationId: string) => ['service', 'ticket-requests', organizationId] as const,
  slaReport: (period: string, organizationId?: string) => ['service', 'sla-report', period, organizationId ?? null] as const,
};

/** FR-SRV-04: response and resolution against the contract's SLA, counted in support hours only. */
export function useSlaReport(period: string, organizationId?: string) {
  const [year, month] = period.split('-');
  return useQuery({
    queryKey: serviceKeys.slaReport(period, organizationId),
    enabled: Boolean(year && month),
    queryFn: async ({ signal }) =>
      (await api.get<SlaReport>(`${BASE}/sla-report${query({ year, month, organizationId })}`, signal)).data,
  });
}

export function useServiceSummary(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: serviceKeys.summary(organizationId),
    enabled,
    queryFn: async ({ signal }) => (await api.get<ServiceSummary>(`${BASE}/organizations/${organizationId}/summary`, signal)).data,
  });
}

/** Open first, newest first; a page at a time with the count of all (DEV-12). */
export function useTickets(filters: { organizationId?: string; contactId?: string; openOnly?: boolean; days?: number }, enabled = true) {
  return usePagedList<Ticket>(serviceKeys.tickets(filters), `${BASE}/tickets`, filters, { enabled, limit: 25 });
}

/** By machine name; the counts per type come from the summary, which counts every device. */
export function useDevices(organizationId: string, enabled = true) {
  return usePagedList<Device>(serviceKeys.devices(organizationId), `${BASE}/devices`, { organizationId }, { enabled, limit: 25 });
}

export function useAlerts(organizationId: string, enabled = true) {
  return usePagedList<Alert>(serviceKeys.alerts(organizationId), `${BASE}/alerts`, { organizationId }, { enabled, limit: 25 });
}

/** Requests that still need attention: pending (the worker picks them up within a minute) or failed. */
export function useTicketRequests(organizationId: string, enabled = true) {
  return usePagedList<TicketRequest>(
    serviceKeys.requests(organizationId),
    `${BASE}/ticket-requests`,
    { organizationId, attentionOnly: true },
    { enabled, limit: 20, refetchWhile: (r) => r.status === 'Pending' },
  );
}

export function useTicketOptions(enabled = true) {
  return useQuery({
    queryKey: ['service', 'ticket-options'],
    enabled,
    staleTime: 600_000,
    queryFn: async ({ signal }) => (await api.get<TicketOptions>(`${BASE}/ticket-options`, signal)).data,
  });
}

export function useCreateTicketRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { organizationId: string; contactId: string | null; title: string; description: string; priority: string; type: string }) =>
      api.post<TicketRequest>(`${BASE}/ticket-requests`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: serviceKeys.all }),
  });
}
