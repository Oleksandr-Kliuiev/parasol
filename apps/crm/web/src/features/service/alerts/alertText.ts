import type { TFunction } from 'i18next';

/** The vendor named as the alert's source ("Source: Atera"); a system without a name of its own is shown as stored. */
export function sourceName(t: TFunction, system: string): string {
  return t(`alerts.sourceNames.${system}`, { defaultValue: system });
}
