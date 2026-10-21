import type { TFunction } from 'i18next';

export const entityTypeOf = (externalType: string): 'Organization' | 'Contact' | 'Product' | null =>
  externalType === 'Customer'
    ? 'Organization'
    : externalType === 'Contact' || externalType === 'ContactPerson'
      ? 'Contact'
      : externalType === 'Product'
        ? 'Product'
        : null;

export const entityRoute = (externalType: string, entityId: string): string | null => {
  const entity = entityTypeOf(externalType);
  return entity === 'Organization'
    ? `/organizations/${entityId}`
    : entity === 'Contact'
      ? `/contacts/${entityId}`
      : entity === 'Product'
        ? `/catalog/products/${entityId}`
        : null;
};

export const systemName = (t: TFunction, system: string) => t(`systems.${system}`, { defaultValue: system });
export const typeName = (t: TFunction, type: string) => t(`externalTypes.${type}`, { defaultValue: type });
export const jobName = (t: TFunction, job: string) => t(`integrations.jobNames.${job}`, { defaultValue: job });

/** Minutes as people read a limit: 15 min, 36 h 15 min, 3 d 2 h (the spans of the monitoring panel). */
export function formatSpan(t: TFunction, minutes: number): string {
  if (minutes <= 120) return t('monitoring.span.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? t('monitoring.span.hoursMinutes', { hours, minutes: minutes % 60 }) : t('monitoring.span.hours', { count: hours });
  return hours % 24 ? t('monitoring.span.daysHours', { days: Math.floor(hours / 24), hours: hours % 24 }) : t('monitoring.span.days', { count: hours / 24 });
}
