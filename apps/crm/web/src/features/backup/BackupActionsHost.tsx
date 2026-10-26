import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ActionDialog } from '../actions/ActionDialog';
import type { ActionRequest, VendorAction } from '../actions/types';
import { BackupActionsContext, restoreKinds, useBackupKinds, type BackupKind } from './backupActions';
import { backupKeys } from './api';
import { RestoreDialog } from './RestoreDialog';
import type { BackupEntity } from './types';

/**
 * Holds the confirmation of a CloudAlly action and the restore wizard outside the rows of the tab (M42), as the alert queue does:
 * the lists reload while a dialog is open, and a dialog inside a row would go with it. An action that went through reads the
 * tab again, so it shows what CloudAlly shows now.
 */
export function BackupActionsHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation(); const client = useQueryClient();
  const kinds = useBackupKinds();
  const [asked, setAsked] = useState<ActionRequest | null>(null);
  const [restoring, setRestoring] = useState<BackupEntity | null>(null);
  const ask = useCallback((request: ActionRequest) => setAsked(request), []);
  const restore = useCallback((entity: BackupEntity) => setRestoring(entity), []);
  const value = useMemo(() => ({ kinds, ask, restore }), [kinds, ask, restore]);
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') void client.invalidateQueries({ queryKey: backupKeys.all });
  };
  const kind = asked?.kind as BackupKind | undefined;
  return <BackupActionsContext.Provider value={value}>
    {children}
    <ActionDialog request={asked} title={kind ? t(`backup.actions.${kind}.title`) : ''} confirm={kind ? t(`backup.actions.${kind}.confirm`) : ''}
      onClose={() => setAsked(null)} onFinished={finished} />
    {restoring && <RestoreDialog entity={restoring} kinds={restoreKinds.filter((k) => kinds.has(k))} onClose={() => setRestoring(null)}
      onContinue={(request) => { setRestoring(null); setAsked(request); }} />}
  </BackupActionsContext.Provider>;
}
