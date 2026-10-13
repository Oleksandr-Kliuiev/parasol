// GET /clients → ClientSummary[] {id, name} (packages/graph/prisma-context.ts listClients). DOM-free.
import { LIMITS, SCOPE_ID_PATTERN } from './contracts.ts';
import type { ClientSummary } from './contracts.ts';
import { array, displayText, matching, object, string, fail } from './validate-core.ts';

/**
 * The whole list or nothing: at most LIMITS.clients entries (more is RESPONSE_TOO_LARGE), every ID a well-formed scope
 * identifier, no repeated ID. Server order is preserved. Additive fields are ignored and never retained.
 */
export function validateClients(value: unknown): ClientSummary[] {
  const items = array(value, LIMITS.clients);
  const seen = new Set<string>();
  return items.map(raw => {
    const row = object(raw);
    const id = matching(row.id, SCOPE_ID_PATTERN);
    const name = string(row.name);
    if (seen.has(id)) fail();
    seen.add(id);
    return Object.freeze({ id, name });
  });
}

export interface PickerView {
  readonly rows: readonly ClientSummary[];
  /** Number of accepted clients matching the search; rows holds at most LIMITS.pickerRows of them. */
  readonly matching: number;
  readonly total: number;
  readonly limited: boolean;
}

/**
 * Local narrowing search over the accepted list by name or ID (case-insensitive substring). At most LIMITS.pickerRows
 * matching rows are shown, in server order; `limited` tells the view to say so instead of implying a server total.
 * The search compares against the full, unshortened name.
 */
export function pickerView(clients: readonly ClientSummary[], search: string): PickerView {
  const needle = search.slice(0, LIMITS.searchLength).toLocaleLowerCase();
  const matches = needle === '' ? clients
    : clients.filter(c => c.id.toLocaleLowerCase().includes(needle) || c.name.toLocaleLowerCase().includes(needle));
  return { rows: matches.slice(0, LIMITS.pickerRows), matching: matches.length, total: clients.length, limited: matches.length > LIMITS.pickerRows };
}

/** Picker label: the name shortened for display, or the ID when the name is empty. */
export function clientLabel(client: ClientSummary): { text: string; shortened: boolean } {
  return client.name.trim() === '' ? { text: client.id, shortened: false } : displayText(client.name);
}
