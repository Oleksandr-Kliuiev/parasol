import type { AuditEntry } from '../../api/types';

/** The pill colour of an audited action: what was added, changed, removed or only read/used. */
export const actionColor = (action: string): 'success' | 'informative' | 'danger' | 'subtle' =>
  action === 'Create' ? 'success' : action === 'Update' ? 'informative' : action === 'Delete' || action === 'Erase' ? 'danger' : 'subtle';

/** The page of the record an entry is about, where the CRM has one. */
export function recordLink(entry: AuditEntry): string | null {
  if (entry.entityType === 'Organization') return `/organizations/${entry.entityId}`;
  if (entry.entityType === 'Contact') return `/contacts/${entry.entityId}`;
  return null;
}
