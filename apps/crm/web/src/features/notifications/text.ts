import type { Notification } from './types';

/** The parameter a notice counts in ("in 1 day", "3 hours left", "12 licences"), read as a number for the plural form. */
const COUNTED = ['days', 'hours', 'quantity'] as const;

/** Renders one notice from its kind and parameters, so the reader sees it in their own language. */
export function notificationText(
  notification: Notification,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (notification.kind === 'VendorActionUncertain') return vendorActionText(notification.parameters, t);
  // A reader without finance gets an overdue invoice without its amount (DEV-12-AC04): the server leaves the amount out.
  const kind = notification.kind === 'InvoiceOverdue' && notification.parameters.amount === undefined ? 'InvoiceOverdueWithoutAmount' : notification.kind;
  const counted = COUNTED.map((key) => notification.parameters[key]).find((value) => value !== undefined);
  const count = counted !== undefined && /^\d+([.,]\d+)?$/.test(counted) ? Number(counted.replace(',', '.')) : undefined;
  return t(`notifications.kinds.${kind}`, count === undefined ? notification.parameters : { ...notification.parameters, count });
}

/** An action at a vendor without a clear answer: the vendor and the action as the interface names them, and its ticket when it has one. */
function vendorActionText(p: Record<string, string>, t: (key: string, options?: Record<string, unknown>) => string): string {
  const system = p.system ?? '';
  const values = {
    ...p,
    system: t(`systems.${system}`, { defaultValue: system }),
    action: t(`actions.kinds.${system}.${p.kind ?? ''}`, { defaultValue: p.kind ?? '' }),
    organization: p.organization ?? '—',
  };
  return t(p.ticket === undefined ? 'notifications.kinds.VendorActionUncertainNoTicket' : 'notifications.kinds.VendorActionUncertain', values);
}
