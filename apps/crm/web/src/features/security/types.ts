/** One kind of indicator an incident found, and how many of it (Huntress's words: `footholds`, `process_detections`, …). */
export interface Indicator {
  type: string;
  count: number;
}

/** One line of a remediation step's detail as Huntress wrote it: what (a path, a key, an account) and its value. */
export interface RemediationDetail {
  name: string | null;
  value: string;
}

/** `assisted`: Huntress carries it out once approved; `manual`: a person does it and marks it; `containment`. */
export type RemediationType = 'assisted' | 'manual' | 'containment';

/** One step of an incident's plan (M41), as the security mirror has it. */
export interface Remediation {
  externalId: number;
  type: RemediationType | string;
  action: string | null;
  details: RemediationDetail[];
  /** `unapproved`, `approved`, `completed`, `failed` or `cancelled`. */
  status: string;
  approvedAt: string | null;
  approvedBy: string | null;
  completedAt: string | null;
}

export interface IncidentComment {
  externalId: number;
  body: string;
  author: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * A Huntress incident behind an alert (M41): the SOC's summary, the indicators, the plan and the comments, each with the time it was
 * last read. `status` is Huntress's: `sent` waits for the partner, `auto_remediating` for Huntress's automation, `draft` for the SOC.
 */
export interface Incident {
  id: string;
  system: string;
  externalId: number;
  organizationId: string;
  organizationName: string | null;
  externalOrganizationId: number;
  agentExternalId: string | null;
  deviceName: string | null;
  status: string;
  isOpen: boolean;
  severity: string;
  subject: string;
  summary: string | null;
  body: string | null;
  platform: string | null;
  indicators: Indicator[];
  sentAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  url: string | null;
  readAt: string;
  remediationsReadAt: string | null;
  commentsReadAt: string | null;
  remediations: Remediation[];
  comments: IncidentComment[];
}

export type NoticeKind = 'Escalation' | 'PlatformAction';

/** What a notice is about, as Huntress names it: a host, an identity, a mailbox. */
export interface NoticeEntity {
  type: string;
  id: string | null;
  name: string | null;
}

/** An escalation (Huntress asks the partner to decide) or a platform action (something keeps Huntress from protecting), M41. */
export interface Notice {
  id: string;
  system: string;
  kind: NoticeKind;
  externalId: number;
  organizationId: string | null;
  organizationName: string | null;
  status: string;
  isOpen: boolean;
  severity: string;
  subject: string;
  type: string | null;
  typeCode: string | null;
  subtype: string | null;
  entities: NoticeEntity[];
  allEntities: boolean;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string | null;
  url: string | null;
  readAt: string;
  entitiesReadAt: string | null;
}

/** What Huntress counts for one of its organizations linked to the customer. */
export interface Usage {
  system: string;
  externalOrganizationId: number;
  name: string;
  agentsCount: number | null;
  billableAgents: number | null;
  unresponsiveAgents: number | null;
  outdatedAgents: number | null;
  isolatedAgents: number | null;
  billableIdentities: number | null;
  satLearners: number | null;
  billableLogSources: number | null;
  readAt: string;
}

export interface SummaryReport {
  system: string;
  externalId: number;
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  agentsCount: number | null;
  incidentsReported: number | null;
  incidentsResolved: number | null;
  signalsDetected: number | null;
  signalsInvestigated: number | null;
  url: string | null;
}

/** The latest finished read of one Huntress job: when it started, whether it read everything, whether the next one is overdue. */
export interface SecurityRead {
  system: string;
  job: string;
  startedAt: string | null;
  complete: boolean;
  late: boolean;
}

/** A customer's security at a glance (M41): what Huntress counts, its reports, and the reads they come from. */
export interface SecurityOverview {
  usage: Usage[];
  reports: SummaryReport[];
  reportsTotal: number;
  reads: SecurityRead[];
}

/** The record behind a Huntress alert, from the alert's id (`incident:7001`, `escalation:45`, `platform-action:9`). */
export type SecurityRecord = { kind: 'incident'; id: number } | { kind: 'escalation' | 'platform-action'; id: number };
