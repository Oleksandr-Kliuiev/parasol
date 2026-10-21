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

/**
 * The latest finished read of one kind of service data (M39.2), as the alert reads: a figure of a source never read is not a zero,
 * a read that did not finish or whose successor is overdue is said so.
 */
export interface ServiceSourceRead extends AlertSourceRead {
  source: 'tickets' | 'conversations' | 'alerts' | 'devices';
}

export interface ServiceSummary {
  openTickets: number;
  ticketsLast90Days: number;
  devices: Partial<Record<DeviceType, number>>;
  devicesOnline: number;
  criticalAlerts: number;
  warningAlerts: number;
  lastSyncedAt: string | null;
  reads: ServiceSourceRead[];
}

/** One ticket with what its panel shows (M39.2): the ticket list's read and the conversation's own read time. */
export interface TicketDetail extends Omit<Ticket, 'organizationName' | 'contactName'> {
  system: string;
  organizationName: string | null;
  contactName: string | null;
  endUserEmail: string | null;
  impact: string | null;
  source: string | null;
  technicianUserId: string | null;
  firstResponseAt: string | null;
  commentsReadAt: string | null;
  ticketsRead: ServiceSourceRead;
  conversationsRead: ServiceSourceRead;
}

export type TicketCommentAuthor = 'Unknown' | 'Technician' | 'EndUser';

/** One message of a ticket's conversation as the CRM last read it. */
export interface TicketComment {
  id: string;
  externalId: string;
  text: string;
  isInternal: boolean;
  author: TicketCommentAuthor;
  authorName: string | null;
  technicianUserId: string | null;
  createdAt: string;
}

/** An Atera technician a ticket can be given to, with the CRM user they are mapped to. */
export interface AteraTechnician {
  id: string;
  name: string;
  email: string | null;
  userId: string | null;
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
