import { createContext, useContext } from 'react';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { useActionAvailable } from '../../actions/api';
import type { ActionRequest } from '../../actions/types';
import type { Alert } from '../types';

/** What can be asked of an alert's source (M40): Atera's API resolves and deletes alerts, and nothing else. */
export type AlertSourceKind = 'alert.resolve' | 'alert.delete';

export type AlertLike = Pick<Alert, 'id' | 'system' | 'externalId' | 'title' | 'state'>;

export const alertRequest = (alert: Pick<Alert, 'system' | 'externalId'>, kind: AlertSourceKind): ActionRequest =>
  ({ system: alert.system, kind, targetType: 'alert', targetId: alert.externalId, parameters: {} });

export interface AlertActionsValue {
  /** Opens the confirmation of one action at the alert's source. */
  ask: (alert: AlertLike, kind: AlertSourceKind) => void;
}

export const AlertActionsContext = createContext<AlertActionsValue | null>(null);

/** The action confirmation of the list or panel the caller is in (AlertActionsHost). */
export function useAlertActions(): AlertActionsValue {
  const value = useContext(AlertActionsContext);
  if (!value) throw new Error('useAlertActions must be used inside <AlertActionsHost>.');
  return value;
}

/** Which source actions a person may ask for an alert now: their right, the kinds switched on, and an alert still open. */
export function useAlertSourceKinds(alert: Pick<Alert, 'system' | 'state'>): AlertSourceKind[] {
  const canWrite = useCan(Permissions.serviceWrite);
  const open = canWrite && alert.system === 'atera' && alert.state !== 'Resolved';
  const resolve = useActionAvailable(alert.system, 'alert.resolve', open);
  const remove = useActionAvailable(alert.system, 'alert.delete', open);
  return [...(resolve ? ['alert.resolve' as const] : []), ...(remove ? ['alert.delete' as const] : [])];
}
