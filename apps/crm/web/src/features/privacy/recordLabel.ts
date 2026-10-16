/** A record in a plan, hold or receipt: its kind in the reader's language and the start of its id (no personal data). */
export function recordLabel(t: (key: string, options?: Record<string, unknown>) => string, module: string, entityType: string, entityId: string): string {
  return `${t(`privacy.records.${entityType}`, { defaultValue: `${module} · ${entityType}` })} ${entityId.slice(0, 8)}`;
}
