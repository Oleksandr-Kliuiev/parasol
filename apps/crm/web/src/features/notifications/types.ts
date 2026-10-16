export const notificationKinds = [
  'ContractEnding',
  'NoticeDeadline',
  'HourBankLow',
  'SubscriptionCancellationWindow',
  'SubscriptionRenewal',
  'StaleOpportunity',
  'InvoiceOverdue',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export type EmailStatus = 'Pending' | 'Sent' | 'Failed' | 'Suppressed';

export interface Notification {
  id: string;
  kind: NotificationKind;
  /** Values the text needs: contract number, customer, hours left. */
  parameters: Record<string, string>;
  organizationId: string | null;
  link: string | null;
  dueDate: string | null;
  warning: boolean;
  isUnread: boolean;
  createdAt: string;
  emailStatus: EmailStatus;
}

export interface NotificationList {
  unread: number;
  items: Notification[];
  /** Continues the list (DEV-12); the bell reads only the first page. */
  nextCursor: string | null;
  totalCount: number;
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  digestHour: number;
  mutedKinds: NotificationKind[];
  /** False when the tenant has no sender mailbox: notices then only live in the CRM. */
  emailAvailable: boolean;
}
