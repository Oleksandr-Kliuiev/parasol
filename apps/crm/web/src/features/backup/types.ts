/** The Microsoft 365 services a backup covers (M42); Teams includes Microsoft 365 groups. */
export type BackupService = 'Mail' | 'OneDrive' | 'SharePoint' | 'Teams' | 'Other';

export const backupServices: readonly BackupService[] = ['Mail', 'OneDrive', 'SharePoint', 'Teams', 'Other'];

/** Where a backed-up mailbox, OneDrive, site or team stands, in the order that needs attention first. */
export type BackupState = 'Failed' | 'Late' | 'Paused' | 'NotInBackup' | 'Waiting' | 'Ok' | 'Aside';

export const backupProblems: readonly BackupState[] = ['Failed', 'Late', 'Paused', 'NotInBackup'];

/** When CloudAlly was last read for the tab: never (null), part-way, or completely, and whether the next read is late. */
export interface BackupRead {
  system: string;
  startedAt: string | null;
  complete: boolean;
  late: boolean;
}

export interface BackupAccount {
  id: string;
  externalId: string;
  name: string;
  email: string | null;
  status: string | null;
  region: string | null;
  outsideRegion: boolean;
  tasks: number;
}

export interface BackupServiceCounts {
  service: BackupService;
  total: number;
  ok: number;
  failed: number;
  late: number;
  paused: number;
  notInBackup: number;
  waiting: number;
  newestBackupAt: string | null;
  oldestBackupAt: string | null;
}

export interface BackupTask {
  id: string;
  externalId: string;
  accountExternalId: string;
  accountName: string;
  service: BackupService;
  source: string;
  alias: string | null;
  status: string | null;
  paused: boolean;
  running: boolean;
  lastBackupAt: string | null;
  nextBackup: string | null;
  entities: number;
  problems: number;
}

/**
 * The licence check: NoAccount (no CloudAlly account), Checked (Partner Center's reading), Marked (no reading, so the mailboxes
 * CloudAlly itself marks as licensed) or NoData (neither).
 */
export interface BackupLicences {
  state: 'NoAccount' | 'NoData' | 'Checked' | 'Marked';
  licensed: number | null;
  backedUp: number;
  missing: number | null;
  readOn: string | null;
}

export interface BackupOverview {
  organizationId: string;
  read: BackupRead;
  lateAfterHours: number;
  accounts: BackupAccount[];
  services: BackupServiceCounts[];
  tasks: BackupTask[];
  licences: BackupLicences;
}

export interface BackupEntity {
  id: string;
  externalId: string;
  taskExternalId: string;
  accountExternalId: string;
  service: BackupService;
  name: string;
  fullName: string | null;
  state: BackupState;
  status: string | null;
  running: boolean;
  lastBackupAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  errorLink: string | null;
  licensing: string | null;
}
