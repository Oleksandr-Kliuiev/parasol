import { describe, expect, it } from 'vitest';
import { localReadiness } from '../../test/localReadiness';
import { parseLocalReadiness, type LocalReadinessView } from './localReadinessContract';

describe('closed local readiness metadata', () => {
  it('accepts disabled local flags beside historical success without claiming current connectivity', () => {
    const value = localReadiness(); expect(parseLocalReadiness(value)).toEqual(value);
    expect(value.admin.microsoftGraph.enabled).toBe(false); expect(value.admin.microsoftGraph.stored!.directoryLastSucceededAt).not.toBeNull();
  });
  it.each([
    ['unknown field', (v: LocalReadinessView) => { Object.assign(v, { token: 'synthetic-private' }); }],
    ['unexpected provider URL', (v: LocalReadinessView) => { Object.assign(v.admin.atera, { baseUrl: 'https://private.invalid' }); }],
    ['unexpected section', (v: LocalReadinessView) => { Object.assign(v, { personal: { status: 'PRESENT' } }); }],
    ['connectivity assertion', (v: LocalReadinessView) => { Object.assign(v, { connectivity: 'CONNECTED' }); }],
    ['unknown mode', (v: LocalReadinessView) => { Object.assign(v.admin, { authMode: 'OTHER' }); }],
    ['invalid date', (v: LocalReadinessView) => { v.checkedAt = 'yesterday'; }],
    ['missing administration', (v: LocalReadinessView) => { Object.assign(v, { admin: null }); }],
    ['unavailable state retaining complete status', (v: LocalReadinessView) => { v.admin.atera.stored = null; }],
    ['negative count', (v: LocalReadinessView) => { v.admin.atera.stored!.records = -1; }],
    ['unlinked count exceeding records', (v: LocalReadinessView) => { v.admin.atera.stored!.unlinkedRecords = 5; }],
    ['unsafe integer', (v: LocalReadinessView) => { v.admin.atera.stored!.records = Number.MAX_SAFE_INTEGER + 1; }],
  ])('rejects the entire local view for %s', (_, mutate) => {
    const value = localReadiness(); mutate(value); expect(parseLocalReadiness(value)).toBeNull();
  });
  it('labels unreadable saved state as partial and accepts it only without stored figures', () => {
    const value = localReadiness(); value.status = 'PARTIAL';
    expect(parseLocalReadiness(value)).toBeNull();
    value.admin.atera.stored = null; value.admin.powerOffice.stored = null; value.admin.microsoftGraph.stored = null;
    expect(parseLocalReadiness(value)).toEqual(value);
  });
});
