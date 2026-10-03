export const deviceTypes = ['Workstation', 'Server', 'Network', 'Other'] as const;
export type DeviceType = (typeof deviceTypes)[number];
export type AlertSeverity = 'Critical' | 'Warning';
export type TicketRequestStatus = 'Pending' | 'Created' | 'Failed';

export interface Ticket {
  id: string;
  externalId: number;
  organizationId: string;
  organizationName: string | null;
  contactId: string | null;
  contactName: string | null;
  title: string;
  status: string;
  isOpen: boolean;
  priority: string | null;
  type: string | null;
  technicianName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  lastActivityAt: string | null;
  url: string | null;
}

export interface Device {
  id: string;
  machineName: string;
  type: DeviceType;
  os: string | null;
  online: boolean;
  lastSeenAt: string | null;
  url: string | null;
  removedAt: string | null;
}

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  deviceName: string | null;
  createdAt: string;
}

export interface ServiceSummary {
  openTickets: number;
  ticketsLast90Days: number;
  devices: Partial<Record<DeviceType, number>>;
  devicesOnline: number;
  criticalAlerts: number;
  warningAlerts: number;
  lastSyncedAt: string | null;
}

export interface TicketRequest {
  id: string;
  title: string;
  status: TicketRequestStatus;
  externalTicketId: number | null;
  url: string | null;
  error: string | null;
  createdAt: string;
}

export interface TicketOptions {
  priorities: string[];
  types: string[];
}

/** One ticket measured against the SLA of the customer's contract (FR-SRV-04). */
export interface SlaTicketRow {
  ticketId: string;
  externalId: number;
  title: string;
  priority: string;
  createdAt: string;
  responseMinutes: number | null;
  resolutionMinutes: number | null;
  responseTarget: number;
  resolutionTarget: number;
  responseBreached: boolean;
  resolutionBreached: boolean;
  stillOpen: boolean;
  url: string | null;
}

export interface SlaOrganizationRow {
  organizationId: string;
  organizationName: string;
  contractNumber: string | null;
  policyName: string | null;
  coverage: 'Business8x5' | 'Extended12x5' | 'Always24x7' | null;
  tickets: number;
  resolved: number;
  responseMeasured: number;
  responseMet: number;
  resolutionMeasured: number;
  resolutionMet: number;
  responseMetPct: number;
  resolutionMetPct: number;
  medianResponseMinutes: number | null;
  breaches: SlaTicketRow[];
}

export interface SlaReport {
  periodStart: string;
  periodEnd: string;
  tickets: number;
  withoutSla: number;
  responseMetPct: number;
  resolutionMetPct: number;
  organizations: SlaOrganizationRow[];
}
