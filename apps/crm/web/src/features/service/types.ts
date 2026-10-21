export const deviceTypes = ['Workstation', 'Server', 'Network', 'Other'] as const;
export type DeviceType = (typeof deviceTypes)[number];
export type AlertSeverity = 'Critical' | 'Warning';
export const alertSeverities = ['Critical', 'Warning'] as const satisfies readonly AlertSeverity[];
/** Open in its source; seen by someone in the CRM (still open); no longer reported open. */
export type AlertState = 'Open' | 'Acknowledged' | 'Resolved';
/** What watches the customer: device monitoring (Atera), security (Huntress) or backup (CloudAlly). */
export type AlertKind = 'Monitoring' | 'Security' | 'Backup';
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
  /** Open alerts matched to this device (M38). */
  openAlerts: number;
}

/** A stored alert (M38). `createdAt` is the source's time; `url` is set only when a link to the source is configured. */
export interface Alert {
  id: string;
  organizationId: string;
  organizationName: string | null;
  system: string;
  kind: AlertKind;
  externalId: string;
  severity: AlertSeverity;
  state: AlertState;
  title: string;
  deviceName: string | null;
  deviceId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  resolvedAt: string | null;
  url: string | null;
}

/**
 * The latest finished read of one alert source (M38). One that did not finish (failed, stopped part-way, held by a pause) left
 * the alerts of an earlier read in place; a late one ended longer ago than its job's freshness limit, so the next is overdue.
 */
export interface AlertSourceRead {
  system: string;
  startedAt: string | null;
  complete: boolean;
  late: boolean;
}

/** A page of alerts; the counts cover the whole filter, not the page (DEV-12); the reads say how fresh the stored alerts are. */
export interface AlertPage {
  items: Alert[];
  nextCursor: string | null;
  totalCount: number;
  critical: number;
  warning: number;
  reads: AlertSourceRead[];
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
  /** The worst breaches, at most ten; `breachCount` counts all of them (DEV-12). */
  breaches: SlaTicketRow[];
  breachCount: number;
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
