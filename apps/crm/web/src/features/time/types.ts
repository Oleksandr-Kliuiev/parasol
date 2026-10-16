export const timeStatuses = ['New', 'Approved', 'NonBillable', 'Invoiced'] as const;
export type TimeEntryStatus = (typeof timeStatuses)[number];
export type TimeSource = 'Atera' | 'Crm';
export type TimeClassification = 'NonBillable' | 'Covered' | 'HourBank' | 'Rate';

export interface Allocation {
  classification: TimeClassification;
  hours: number;
  billedHours: number;
  /** Only for users with finance.read. */
  rate?: number | null;
  amount?: number | null;
  hourBankId: string | null;
}

export interface TimeEntry {
  id: string;
  source: TimeSource;
  organizationId: string;
  organizationName: string | null;
  technicianId: string | null;
  technicianName: string | null;
  externalTicketId: number | null;
  ticketTitle: string | null;
  workDate: string;
  startedAt: string | null;
  hours: number;
  workType: string | null;
  billable: boolean;
  onsite: boolean;
  afterHours: boolean;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  status: TimeEntryStatus;
  amount?: number | null;
  reviewNote: string | null;
  isLocked: boolean;
  allocations: Allocation[];
  etag: string;
}

export interface TimeSummary {
  hours: number;
  billableHours: number;
  approvedHours: number;
  newHours: number;
  amount?: number;
}

/** One page of entries and the summary of every entry the filter matches (DEV-12). */
export interface TimeEntryPage {
  items: TimeEntry[];
  summary: TimeSummary;
  periodClosed: boolean;
  nextCursor: string | null;
  totalCount: number;
}

export interface TimeEntryRequest {
  organizationId: string;
  technicianId: string | null;
  workDate: string;
  hours: number;
  workType: string | null;
  billable: boolean;
  onsite: boolean;
  afterHours: boolean;
  description: string | null;
  externalTicketId: number | null;
  ticketTitle: string | null;
  projectId: string | null;
}

export interface Period {
  year: number;
  month: number;
  isClosed: boolean;
  closedAt: string | null;
  closedByName: string | null;
  reopenReason: string | null;
  newEntries: number;
  hours: number;
}

export interface ApprovalSummary {
  approved: number;
  skipped: number;
  amount: number;
  skippedReasons: string[];
}

export interface TechnicianMapping {
  id: string;
  system: string;
  externalId: string;
  name: string | null;
  email: string | null;
  userId: string | null;
  userName: string | null;
  method: 'Unmapped' | 'Email' | 'Manual';
  lastSeenAt: string;
}
