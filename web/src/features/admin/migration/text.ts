import type { TFunction } from 'i18next';

/** A reason, warning or error code in the user's language; a code the interface does not know is shown as it is. */
export function reasonText(t: TFunction, code: string): string {
  return t(`migration.reasons.${code}`, { defaultValue: code });
}

export function fieldText(t: TFunction, field: string): string {
  return t(`migration.fieldNames.${field}`, { defaultValue: field });
}

export function columnText(t: TFunction, column: string): string {
  return t(`migration.columnNames.${column}`, { defaultValue: column });
}
