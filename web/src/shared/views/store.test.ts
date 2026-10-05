import { describe, expect, it } from 'vitest';
import { cleanQuery, MAX_VIEWS, readViews, upsertView, VIEWS_VERSION, writeViews, type SavedView } from './store';

const memory = (initial?: string) => {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_: string, v: string) => {
      value = v;
    },
  };
};

describe('cleanQuery', () => {
  it('keeps only the allowed keys with short values', () => {
    expect(cleanQuery('status=Active&secret=x&search=' + 'a'.repeat(300) + '&cursor=abc', ['search', 'status'])).toBe('status=Active');
  });
});

describe('readViews', () => {
  it('reads what writeViews stored', () => {
    const storage = memory();
    expect(writeViews(storage, 'k', [{ name: 'Active', query: 'status=Active' }])).toBe(true);
    expect(readViews(storage, 'k', ['status'])).toEqual({ views: [{ name: 'Active', query: 'status=Active' }], discarded: false });
  });
  it('drops an older format and says so', () => {
    expect(readViews(memory('[{"name":"x","filters":{}}]'), 'k', ['status'])).toEqual({ views: [], discarded: true });
    expect(readViews(memory(JSON.stringify({ version: VIEWS_VERSION - 1, views: [] })), 'k', ['status']).discarded).toBe(true);
    expect(readViews(memory('not json'), 'k', ['status']).discarded).toBe(true);
  });
  it('strips keys the page does not allow, so a tampered view cannot inject filters', () => {
    const stored = JSON.stringify({ version: VIEWS_VERSION, views: [{ name: 'x', query: 'status=Active&limit=100000' }] });
    expect(readViews(memory(stored), 'k', ['status']).views[0]?.query).toBe('status=Active');
  });
  it('is empty when nothing is stored or storage throws', () => {
    expect(readViews(memory(), 'k', [])).toEqual({ views: [], discarded: false });
    expect(readViews({ getItem: () => { throw new Error('blocked'); } }, 'k', [])).toEqual({ views: [], discarded: false });
  });
});

describe('writeViews / upsertView', () => {
  it('reports a refused write', () => {
    expect(writeViews({ setItem: () => { throw new Error('quota'); } }, 'k', [])).toBe(false);
  });
  it('replaces a view of the same name and refuses an eleventh', () => {
    const full: SavedView[] = Array.from({ length: MAX_VIEWS }, (_, i) => ({ name: `v${i}`, query: '' }));
    expect(upsertView(full, { name: 'v3', query: 'status=Active' })).toHaveLength(MAX_VIEWS);
    expect(upsertView(full, { name: 'new', query: '' })).toBe('full');
  });
});
