import { createContext, useContext } from 'react';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useActionAvailable } from '../actions/api';
import type { ActionRequest } from '../actions/types';
import type { BackupAccount, BackupEntity, BackupService, BackupTask } from './types';

export const CLOUDALLY = 'cloudally';

/** What can be asked of CloudAlly (M42); every kind is off until the installation switches it on. */
export type BackupKind =
  | 'backup.run' | 'backup.activate' | 'backup.pause' | 'backup.resume' | 'account.deactivate'
  | 'restore.export' | 'restore.other' | 'restore.in-place';

export type RestoreKind = 'restore.export' | 'restore.other' | 'restore.in-place';

export const restoreKinds: readonly RestoreKind[] = ['restore.export', 'restore.other', 'restore.in-place'];

/** The services Parasoll restores through CloudAlly's API: whole mailboxes, OneDrives and sites. */
export const restorable = (service: BackupService) => service === 'Mail' || service === 'OneDrive' || service === 'SharePoint';

export const taskRequest = (task: Pick<BackupTask, 'externalId'>, kind: BackupKind): ActionRequest =>
  ({ system: CLOUDALLY, kind, targetType: 'backup-task', targetId: task.externalId, parameters: {} });

/** An entity is reached through its task, which the `task` parameter names. */
export const entityRequest = (entity: Pick<BackupEntity, 'externalId' | 'taskExternalId'>, kind: BackupKind, parameters: Record<string, unknown> = {}): ActionRequest =>
  ({ system: CLOUDALLY, kind, targetType: 'backup-entity', targetId: entity.externalId, parameters: { task: entity.taskExternalId, ...parameters } });

export const accountRequest = (account: Pick<BackupAccount, 'externalId'>): ActionRequest =>
  ({ system: CLOUDALLY, kind: 'account.deactivate', targetType: 'backup-account', targetId: account.externalId, parameters: {} });

/** The kinds this person may ask for now: their right and the kinds switched on, read once for all of them. */
export function useBackupKinds(): ReadonlySet<BackupKind> {
  const canWrite = useCan(Permissions.serviceWrite);
  const kinds: Array<[BackupKind, boolean]> = [
    ['backup.run', useActionAvailable(CLOUDALLY, 'backup.run', canWrite)],
    ['backup.activate', useActionAvailable(CLOUDALLY, 'backup.activate', canWrite)],
    ['backup.pause', useActionAvailable(CLOUDALLY, 'backup.pause', canWrite)],
    ['backup.resume', useActionAvailable(CLOUDALLY, 'backup.resume', canWrite)],
    ['account.deactivate', useActionAvailable(CLOUDALLY, 'account.deactivate', canWrite)],
    ['restore.export', useActionAvailable(CLOUDALLY, 'restore.export', canWrite)],
    ['restore.other', useActionAvailable(CLOUDALLY, 'restore.other', canWrite)],
    ['restore.in-place', useActionAvailable(CLOUDALLY, 'restore.in-place', canWrite)],
  ];
  return new Set(kinds.filter(([, on]) => on).map(([kind]) => kind));
}

export interface BackupActionsValue {
  kinds: ReadonlySet<BackupKind>;
  /** Opens the confirmation of one action; the dialog lives above the lists, which reload while it is open. */
  ask: (request: ActionRequest) => void;
  /** Opens the restore wizard of one mailbox, OneDrive or site. */
  restore: (entity: BackupEntity) => void;
}

export const BackupActionsContext = createContext<BackupActionsValue | null>(null);

export function useBackupActions(): BackupActionsValue {
  const value = useContext(BackupActionsContext);
  if (!value) throw new Error('useBackupActions must be used inside <BackupActionsHost>.');
  return value;
}
