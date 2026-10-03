import type { Notification } from './types';

/** Renders one notice from its kind and parameters, so the reader sees it in their own language. */
export function notificationText(
  notification: Notification,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(`notifications.kinds.${notification.kind}`, notification.parameters);
}
