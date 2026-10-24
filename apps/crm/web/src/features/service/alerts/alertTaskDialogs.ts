import { createContext, useContext } from 'react';
import type { AlertTask } from './alertTasks';

export interface AlertTaskDialogs {
  /** Opens the assign dialog of one alert. */
  open: (alertId: string) => void;
  /** Tasks the dialog made, by alert id, so a row shows its task at once, before the page's lookup is read again. */
  made: ReadonlyMap<string, AlertTask>;
}

export const AlertTaskDialogContext = createContext<AlertTaskDialogs | null>(null);

/** The assign dialog of the list the row is in (AlertTaskDialogHost). */
export function useAlertTaskDialogs(): AlertTaskDialogs {
  const value = useContext(AlertTaskDialogContext);
  if (!value) throw new Error('useAlertTaskDialogs must be used inside <AlertTaskDialogHost>.');
  return value;
}
