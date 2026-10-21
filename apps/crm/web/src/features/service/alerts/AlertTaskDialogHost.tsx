import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCurrentUser } from '../../../auth/CurrentUserContext';
import { AlertTaskDialog } from './AlertTaskDialog';
import { AlertTaskDialogContext } from './alertTaskDialogs';
import type { AlertTask } from './alertTasks';

/**
 * Holds the assign dialog of a list of alerts outside its rows. A row is drawn again when the list reloads for a new search or
 * filter, or switches between table and cards, and a dialog inside it would vanish with its answer ("Task created.") while the
 * task was being made. The rows only ask the host to open it (useAlertTaskDialogs).
 */
export function AlertTaskDialogHost({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const [alertId, setAlertId] = useState<string | null>(null);
  const [made, setMade] = useState<ReadonlyMap<string, AlertTask>>(() => new Map());
  const madeFor = useRef<string | null>(null);
  const open = useCallback((id: string) => { madeFor.current = null; setAlertId(id); }, []);
  const close = () => {
    const id = madeFor.current;
    setAlertId(null);
    // The Assign button is gone once the task exists: focus moves to the task that replaced it, not to the page.
    if (id) queueMicrotask(() => document.querySelector<HTMLElement>(`[data-alert-task="${id}"] a`)?.focus());
  };
  const value = useMemo(() => ({ open, made }), [open, made]);
  return <AlertTaskDialogContext.Provider value={value}>
    {children}
    {alertId && <AlertTaskDialog key={`${user.id}:${alertId}`} alertId={alertId} onClose={close} onTask={(task) => {
      madeFor.current = alertId;
      setMade((current) => new Map(current).set(alertId, task));
    }} />}
  </AlertTaskDialogContext.Provider>;
}
