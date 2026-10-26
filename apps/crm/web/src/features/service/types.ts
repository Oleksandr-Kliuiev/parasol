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

/** One agent of a machine in a list row (M40): its source, its last contact and its link there. */
export interface MachineSource {
  deviceId: string;
  system: string;
  online: boolean;
  lastSeenAt: string | null;
  url: string | null;
}

/** One computer of a customer (M40), whichever sources watch it. */
export interface Machine {
  id: string;
  organizationId: string;
  name: string;
  type: DeviceType;
  os: string | null;
  online: boolean;
  lastSeenAt: string | null;
  removedAt: string | null;
  sources: MachineSource[];
  openAlerts: number;
  /** Other machines of the customer a person should compare this one with. */
  proposals: number;
}

export interface DeviceDisk {
  drive: string | null;
  free: number | null;
  used: number | null;
  total: number | null;
}

/** What one source says about the computer (M40); memory and disks come without a unit in Atera's API. */
export interface DeviceInventory {
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  motherboard: string | null;
  processor: string | null;
  processorCores: number | null;
  processorClock: string | null;
  memory: number | null;
  biosVersion: string | null;
  osVersion: string | null;
  osBuild: string | null;
  lastRebootAt: string | null;
  ipAddresses: string[];
  publicIp: string | null;
  macAddresses: string[];
  domainName: string | null;
  loggedInUsers: string | null;
  lastLoginUser: string | null;
  disks: DeviceDisk[];
  agentVersion: string | null;
}

export interface DevicePatch {
  kbId: string | null;
  name: string;
  class: string | null;
  installedAt: string | null;
  status: string | null;
}

/** A device's Windows updates at the last complete read; `readAt` is null while they were never read. */
export interface DevicePatches {
  readAt: string | null;
  collectedAt: string | null;
  installedCount: number;
  available: DevicePatch[];
  latestInstalled: DevicePatch[];
}

/**
 * What a security source says about the computer's protection (M41, Huntress): Defender's status as Huntress words it, when Huntress
 * last heard it, and whether the computer is cut off from the network (`Isolated`, `Pending Isolation`, `Pending Release`).
 */
export interface DeviceProtection {
  platform: string | null;
  antivirusStatus: string | null;
  antivirusSubstatus: string | null;
  antivirusPolicyStatus: string | null;
  antivirusReportedAt: string | null;
  isolation: string | null;
  agentVersionSince: string | null;
}

export interface MachineDevice {
  id: string;
  system: string;
  externalId: string;
  machineName: string;
  type: DeviceType;
  os: string | null;
  online: boolean;
  lastSeenAt: string | null;
  firstSeenAt: string;
  removedAt: string | null;
  url: string | null;
  inventory: DeviceInventory;
  patches: DevicePatches;
  /** Only for a security source (M41); none for Atera. */
  protection?: DeviceProtection | null;
}

/** Why two machines may be one computer. */
export type MachineEvidence = 'serial' | 'mac' | 'name' | 'serialConflict';

export interface MachineProposal {
  otherMachineId: string;
  otherName: string;
  evidence: MachineEvidence[];
  foundAt: string;
}

/** A machine's card (M40); `etag` goes with a person's decision about it. */
export interface MachineDetail {
  id: string;
  organizationId: string;
  organizationName: string | null;
  name: string;
  type: DeviceType;
  os: string | null;
  online: boolean;
  lastSeenAt: string | null;
  removedAt: string | null;
  devices: MachineDevice[];
  proposals: MachineProposal[];
  openAlerts: number;
  reads: ServiceSourceRead[];
  etag: string;
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
  /** Hidden in Parasoll until a day (M40): the source still has it open. */
  hidden?: AlertHold | null;
  /** Read with one alert only: the ETag a change of its status in Parasoll sends. */
  etag?: string | null;
  /** A coverage gap Parasoll found (M40): the rule that found it and its facts, worded in the reader's language. */
  rule?: string | null;
  facts?: Record<string, string> | null;
  /** The machine the alert's device belongs to (M40): its card in the customer's Drift tab. */
  machineId?: string | null;
  /** When the source closed an urgent alert that waits for a person to confirm it (M41: a Huntress incident). */
  sourceClosedAt?: string | null;
}

/** A rule's limit (M40): its default and the range a person may choose from. */
export interface CoverageThreshold {
  default: number;
  min: number;
  max: number;
  unit: 'Days' | 'Hours';
}

/** One of Parasoll's own coverage rules with its setting (M40); `etag` goes with a change. */
export interface CoverageRule {
  code: string;
  system: string;
  kind: AlertKind;
  threshold: CoverageThreshold | null;
  enabled: boolean;
  value: number | null;
  openGaps: number;
  changedAt: string | null;
  changedByName: string | null;
  etag: string | null;
}

/** An alert hidden in Parasoll (M40): until when, why, by whom and when. */
export interface AlertHold {
  until: string;
  reason: string | null;
  byName: string | null;
  at: string | null;
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
  source: 'tickets' | 'conversations' | 'alerts' | 'devices' | 'patches' | 'security-alerts' | 'security-devices';
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
