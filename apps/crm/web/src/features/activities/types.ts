export const activityTypes = ['Task', 'Call', 'Meeting', 'Note', 'Email'] as const;
export type ActivityType = (typeof activityTypes)[number];
export type ActivityStatus = 'Open' | 'Done' | 'Cancelled';
export const activityPriorities = ['Low', 'Normal', 'High'] as const;
export type ActivityPriority = (typeof activityPriorities)[number];

export interface ActivityRef {
  id: string;
  name: string;
}

export interface Activity {
  id: string;
  type: ActivityType;
  organizationId: string;
  organizationName: string | null;
  opportunityId: string | null;
  contractId: string | null;
  contactId: string | null;
  contactName: string | null;
  subject: string;
  body: string | null;
  dueAt: string | null;
  durationMinutes: number | null;
  location: string | null;
  priority: ActivityPriority;
  assignee: ActivityRef | null;
  status: ActivityStatus;
  completedAt: string | null;
  isOverdue: boolean;
  /** The meeting also lives in the organizer's Outlook calendar (FR-ACT-02). */
  inCalendar: boolean;
  calendarSyncedAt: string | null;
  webLink: string | null;
  fromAddress: string | null;
  createdAt: string;
  createdBy: ActivityRef | null;
  etag: string;
}

export interface ActivityRequest {
  type: ActivityType;
  organizationId: string;
  opportunityId: string | null;
  contractId: string | null;
  contactId: string | null;
  subject: string;
  body: string | null;
  dueAt: string | null;
  priority: ActivityPriority;
  assigneeId: string | null;
  durationMinutes: number | null;
  location: string | null;
  addToCalendar: boolean;
}

export interface OutlookStatus {
  calendar: boolean;
  mail: boolean;
}

export interface MailMessage {
  id: string;
  messageId: string;
  subject: string;
  preview: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  receivedAt: string;
  hasAttachments: boolean;
  webLink: string | null;
  mailbox: string;
  isSaved: boolean;
}

/** The messages and what was searched for them: the customer's domains first, then addresses outside them (DEV-12). */
export interface MailList {
  messages: MailMessage[];
  searched: string[];
  /** Domains and addresses left out of the search to keep one view to a bounded number of Exchange requests. */
  notSearched: number;
}

export interface SaveMailRequest {
  organizationId: string;
  opportunityId: string | null;
  contractId: string | null;
  contactId: string | null;
  messageId: string;
  subject: string;
  preview: string | null;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  webLink: string | null;
}

export interface CalendarSyncResult {
  read: number;
  updated: number;
}
