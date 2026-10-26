import { useMutation, useQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { OrganizationContactItem } from '../../api/types';
import { savedServicePolicy, useSavedServiceList, type SavedServiceScope } from './useSavedServiceList';
import type { Alert, Device, Machine, MachineDetail, ServiceSummary, SlaReport, Ticket, TicketOptions, TicketRequest } from './types';

const BASE = '/api/v1/service';

export const serviceKeys = {
  all: ['service'] as const,
  summary: (organizationId: string) => ['service', 'summary', organizationId] as const,
  tickets: (filters: object) => ['service', 'tickets', filters] as const,
  devices: (organizationId: string) => ['service', 'devices', organizationId] as const,
  machines: (organizationId: string) => ['service', 'machines', organizationId] as const,
  machine: (machineId: string) => ['service', 'machine', machineId] as const,
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

export function useServiceSummary(organizationId: string, scope: SavedServiceScope) {
  return useQuery({
    ...savedServicePolicy, queryKey: [...serviceKeys.summary(organizationId), scope.owner, scope.revision],
    queryFn: async ({ signal }) => {
      const answer = await api.get<ServiceSummary>(`${BASE}/organizations/${organizationId}/summary`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/** Open first, newest first; a page at a time with the count of all (DEV-12). */
export function useTickets(filters: { organizationId?: string; contactId?: string; openOnly?: boolean; days?: number }, scope: SavedServiceScope) {
  return useSavedServiceList<Ticket>(serviceKeys.tickets(filters), `${BASE}/tickets`, filters, scope, 25);
}

/** By machine name; the counts per type come from the summary, which counts every device. */
export function useDevices(organizationId: string, scope: SavedServiceScope) {
  return useSavedServiceList<Device>(serviceKeys.devices(organizationId), `${BASE}/devices`, { organizationId }, scope, 25);
}

/** One row per computer (M40), by name; the counts per type come from the summary, which counts machines too. */
export function useMachines(organizationId: string, scope: SavedServiceScope) {
  return useSavedServiceList<Machine>(serviceKeys.machines(organizationId), `${BASE}/machines`, { organizationId }, scope, 25);
}

/** One machine's card (M40), read when it opens and never kept for later. */
export function useMachine(machineId: string | null) {
  return useQuery({
    ...savedServicePolicy, queryKey: serviceKeys.machine(machineId ?? ''), enabled: machineId !== null,
    queryFn: async ({ signal }) => {
      const answer = await api.get<MachineDetail>(`${BASE}/machines/${machineId}`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/** A person's decision about the machine whose card they read (its ETag): two are one computer, or two, or a device is another. */
export type MachineDecision =
  | { kind: 'join' | 'keep-apart'; otherMachineId: string }
  | { kind: 'detach'; deviceId: string };

export function decideMachine(machine: Pick<MachineDetail, 'id' | 'etag'>, decision: MachineDecision) {
  const { kind, ...body } = decision;
  return api.post<MachineDetail>(`${BASE}/machines/${machine.id}/${kind}`, body, machine.etag);
}

export function useAlerts(organizationId: string, scope: SavedServiceScope) {
  return useSavedServiceList<Alert>(serviceKeys.alerts(organizationId), `${BASE}/alerts`, { organizationId }, scope, 25);
}

/** Requests that still need attention: pending (the worker picks them up within a minute) or failed. */
export function useTicketRequests(organizationId: string, scope: SavedServiceScope) {
  return useSavedServiceList<TicketRequest>(serviceKeys.requests(organizationId), `${BASE}/ticket-requests`,
    { organizationId, attentionOnly: true }, scope, 20, request => request.status === 'Pending');
}

export function useTicketOptions(owner: string) {
  return useQuery({
    ...savedServicePolicy, queryKey: ['service', 'ticket-options', owner],
    queryFn: async ({ signal }) => { const answer = await api.get<TicketOptions>(`${BASE}/ticket-options`, signal); signal.throwIfAborted(); return answer.data; },
  });
}

export function useTicketContacts(organizationId: string, owner: string) {
  return useQuery({
    ...savedServicePolicy, queryKey: ['service', 'ticket-contacts', organizationId, owner],
    queryFn: async ({ signal }) => {
      const answer = await api.get<OrganizationContactItem[]>(`/api/v1/customers/organizations/${organizationId}/contacts`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

export function useCreateTicketRequest() {
  return useMutation({
    mutationFn: (body: { organizationId: string; contactId: string | null; title: string; description: string; priority: string; type: string }) =>
      api.post<TicketRequest>(`${BASE}/ticket-requests`, body),
  });
}
