import type { Notification } from './types';

/** Renders one notice from its kind and parameters, so the reader sees it in their own language. */
export function notificationText(
  notification: Notification,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  // A reader without finance gets an overdue invoice without its amount (DEV-12-AC04): the server leaves the amount out.
  const kind = notification.kind === 'InvoiceOverdue' && notification.parameters.amount === undefined ? 'InvoiceOverdueWithoutAmount' : notification.kind;
  return t(`notifications.kinds.${kind}`, notification.parameters);
}
