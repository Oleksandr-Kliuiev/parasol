// Saved list views: a name and the filter part of the address, kept in this browser per signed-in user.
// A view holds filters only (keys the page allows, short values), never records or amounts, and whatever it shows is
// decided by the server's permissions when it is applied; nothing stored here grants access.

export const VIEWS_VERSION = 1;
export const MAX_VIEWS = 10;
export const MAX_NAME = 40;
export const MAX_VALUE = 200;

export interface SavedView {
  name: string;
  /** Filter part of the address, e.g. `status=Active&search=acme`. */
  query: string;
}

export interface ViewsRead {
  views: SavedView[];
  /** Stored views from an older format were dropped; the page tells the user once. */
  discarded: boolean;
}

export const viewsKey = (userId: string, scope: string) => `crm.views.${userId}.${scope}`;

/** Keeps only the allowed keys with short values, in a stable order. */
export function cleanQuery(query: string, allowed: readonly string[]): string {
  const source = new URLSearchParams(query);
  const result = new URLSearchParams();
  for (const key of allowed) {
    const value = source.get(key);
    if (value && value.length <= MAX_VALUE) result.set(key, value);
  }
  return result.toString();
}

export function readViews(storage: Pick<Storage, 'getItem'>, key: string, allowed: readonly string[]): ViewsRead {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { views: [], discarded: false };
  }
  if (raw === null) return { views: [], discarded: false };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as { version?: unknown }).version !== VIEWS_VERSION) {
      return { views: [], discarded: true };
    }
    const list = (value as { views?: unknown }).views;
    if (!Array.isArray(list)) return { views: [], discarded: true };
    const views = list
      .filter((v): v is SavedView => typeof v?.name === 'string' && v.name.length > 0 && v.name.length <= MAX_NAME && typeof v?.query === 'string')
      .map((v) => ({ name: v.name, query: cleanQuery(v.query, allowed) }))
      .slice(0, MAX_VIEWS);
    return { views, discarded: false };
  } catch {
    return { views: [], discarded: true };
  }
}

/** Returns false when the browser refuses to store (private window, quota). */
export function writeViews(storage: Pick<Storage, 'setItem'>, key: string, views: SavedView[]): boolean {
  try {
    storage.setItem(key, JSON.stringify({ version: VIEWS_VERSION, views }));
    return true;
  } catch {
    return false;
  }
}

export function upsertView(views: SavedView[], view: SavedView): SavedView[] | 'full' {
  const others = views.filter((v) => v.name !== view.name);
  if (others.length >= MAX_VIEWS) return 'full';
  return [...others, view];
}
