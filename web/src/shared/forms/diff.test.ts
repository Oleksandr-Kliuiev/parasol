import { describe, expect, it } from 'vitest';
import { compareWithLatest, diffValues, rebase } from './diff';

const base = { name: 'Acme', phone: '1', visitAddress: { city: 'Oslo', street: 'A' } };

describe('diffValues', () => {
  it('lists changed leaves by path', () => {
    expect(diffValues(base, { ...base, visitAddress: { city: 'Bergen', street: 'A' } }).map((d) => d.path)).toEqual(['visitAddress.city']);
  });
  it('treats missing and null as equal', () => {
    expect(diffValues({ a: null }, {})).toEqual([]);
  });
});

describe('compareWithLatest', () => {
  it('separates overlapping edits from edits only one side made', () => {
    const mine = { ...base, name: 'Acme AS', phone: '2' };
    const latest = { ...base, name: 'Acme Norge', visitAddress: { city: 'Bergen', street: 'A' } };
    const result = compareWithLatest(base, mine, latest);
    expect(result.conflicts.map((c) => c.path)).toEqual(['name']);
    expect(result.conflicts[0]).toMatchObject({ mine: 'Acme AS', theirs: 'Acme Norge' });
    expect(result.changedByOthers).toEqual(['visitAddress.city']);
  });
});

describe('rebase', () => {
  it('lays only the user changes over the latest version', () => {
    const mine = { ...base, phone: '2' };
    const latest = { ...base, name: 'Acme Norge', visitAddress: { city: 'Bergen', street: 'A' } };
    expect(rebase(base, mine, latest)).toEqual({ name: 'Acme Norge', phone: '2', visitAddress: { city: 'Bergen', street: 'A' } });
  });
});
