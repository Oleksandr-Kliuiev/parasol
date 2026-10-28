import { createContext, useContext } from 'react';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { useActionAvailable } from '../../actions/api';
import type { ActionRequest } from '../../actions/types';
import type { Alert } from '../types';

/** What can be asked of an alert's source (M40): Atera's API resolves and deletes alerts, and nothing else. */
export type AlertSourceKind = 'alert.resolve' | 'alert.delete';

export type AlertLike = Pick<Alert, 'id' | 'system' | 'externalId' | 'title' | 'state' | 'hidden' | 'rule' | 'facts' | 'sourceClosedAt'>;

/**
 * What a person can do with an alert in Parasoll itself: hide it until a day, or show it again (M40); confirm the closing of an urgent
 * alert its source closed (M41).
 */
export type AlertParasollKind = 'hide' | 'show' | 'confirm';

/**
 * A hidden or shown alert leaves the list it was in, with the button that changed it (M45: the bulk bar with its selection): focus goes
 * to the list (data-alert-list), never to the page behind it.
 */
export const focusList = () => window.setTimeout(() => document.querySelector<HTMLElement>('[data-alert-list]')?.focus(), 0);

export const alertRequest = (alert: Pick<Alert, 'system' | 'externalId'>, kind: AlertSourceKind): ActionRequest =>
  ({ system: alert.system, kind, targetType: 'alert', targetId: alert.externalId, parameters: {} });

export interface AlertActionsValue {
  /** Opens the confirmation of one action at the alert's source, or the hide dialog; showing again happens at once. */
  ask: (alert: AlertLike, kind: AlertSourceKind | AlertParasollKind) => void;
}

export const AlertActionsContext = createContext<AlertActionsValue | null>(null);

/** The action confirmation of the list or panel the caller is in (AlertActionsHost). */
export function useAlertActions(): AlertActionsValue {
  const value = useContext(AlertActionsContext);
  if (!value) throw new Error('useAlertActions must be used inside <AlertActionsHost>.');
  return value;
}

/** What a person may do with an alert in Parasoll now: confirm a closing its source made, hide an open one, or show a hidden one again. */
export function useAlertParasollKinds(alert: Pick<Alert, 'state' | 'hidden' | 'sourceClosedAt'>): AlertParasollKind[] {
  const canWrite = useCan(Permissions.serviceWrite);
  if (!canWrite || alert.state === 'Resolved') return [];
  return [...(alert.sourceClosedAt ? ['confirm' as const] : []), alert.hidden ? 'show' as const : 'hide' as const];
}

/** Which source actions a person may ask for an alert now: their right, the kinds switched on, and an alert still open. */
export function useAlertSourceKinds(alert: Pick<Alert, 'system' | 'state'>): AlertSourceKind[] {
  const canWrite = useCan(Permissions.serviceWrite);
  const open = canWrite && alert.system === 'atera' && alert.state !== 'Resolved';
  const resolve = useActionAvailable(alert.system, 'alert.resolve', open);
  const remove = useActionAvailable(alert.system, 'alert.delete', open);
  return [...(resolve ? ['alert.resolve' as const] : []), ...(remove ? ['alert.delete' as const] : [])];
}
