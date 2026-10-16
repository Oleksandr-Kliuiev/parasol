import { describe, expect, it } from 'vitest';
import { localReadiness, readinessAdminAuthority as authority } from '../../test/localReadiness';
import { parseLocalReadiness, type LocalReadinessView } from './localReadinessContract';

describe('closed local readiness metadata', () => {
  it('accepts disabled local flags beside historical success without claiming current connectivity', () => {
    const value = localReadiness(); expect(parseLocalReadiness(value, authority)).toEqual(value);
    expect(value.admin!.microsoftGraph.enabled).toBe(false); expect(value.admin!.microsoftGraph.stored!.directoryLastSucceededAt).not.toBeNull();
  });
  it.each([
    ['unknown field', (v: LocalReadinessView) => { Object.assign(v, { token: 'synthetic-private' }); }],
    ['unexpected provider URL', (v: LocalReadinessView) => { Object.assign(v.admin!.atera, { baseUrl: 'https://private.invalid' }); }],
    ['personal credential value', (v: LocalReadinessView) => { Object.assign(v.personalAtlas!, { token: 'synthetic-private' }); }],
    ['connectivity assertion', (v: LocalReadinessView) => { Object.assign(v, { connectivity: 'CONNECTED' }); }],
    ['Huntress configuration assertion', (v: LocalReadinessView) => { Object.assign(v.admin!.huntress, { configuration: 'READY' }); }],
    ['unknown mode', (v: LocalReadinessView) => { Object.assign(v.admin!, { authMode: 'OTHER' }); }],
    ['invalid date', (v: LocalReadinessView) => { v.checkedAt = 'yesterday'; }],
    ['missing authorized personal section', (v: LocalReadinessView) => { v.personalAtlas = null; }],
    ['missing authorized administration', (v: LocalReadinessView) => { v.admin = null; }],
    ['missing authorized mappings', (v: LocalReadinessView) => { v.admin!.atlasMappings = null; }],
    ['wrong mapping limit', (v: LocalReadinessView) => { Object.assign(v.admin!.atlasMappings!, { limit: 501 }); }],
    ['wrong mapping total', (v: LocalReadinessView) => { v.admin!.atlasMappings!.coverage!.storedLinks++; }],
    ['wrong classification sum', (v: LocalReadinessView) => { v.admin!.atlasMappings!.counts!.validLinks++; }],
    ['unexamined links called checked', (v: LocalReadinessView) => { v.admin!.atlasMappings!.coverage!.omittedLinks = 1; v.admin!.atlasMappings!.coverage!.storedLinks++; }],
    ['unlinked references called issue-free', (v: LocalReadinessView) => { v.admin!.atlasMappings!.coverage!.unlinkedStoredReferences++; }],
    ['changed registry retaining counts', (v: LocalReadinessView) => { v.admin!.atlasMappings!.status = 'CHANGED'; }],
    ['unavailable state retaining complete status', (v: LocalReadinessView) => { v.admin!.atera.stored = null; }],
    ['negative count', (v: LocalReadinessView) => { v.admin!.atera.stored!.records = -1; }],
    ['unlinked count exceeding records', (v: LocalReadinessView) => { v.admin!.atera.stored!.unlinkedRecords = 5; }],
    ['unsafe integer', (v: LocalReadinessView) => { v.admin!.atera.stored!.records = Number.MAX_SAFE_INTEGER + 1; }],
  ])('rejects the entire local view for %s', (_, mutate) => {
    const value = localReadiness(); mutate(value); expect(parseLocalReadiness(value, authority)).toBeNull();
  });
  it('rejects administrative data when only personal Atlas reading is allowed', () => {
    const personal = { atlasRead: true, integrationsManage: false, customersRead: true };
    expect(parseLocalReadiness(localReadiness(), personal)).toBeNull();
    expect(parseLocalReadiness(localReadiness(personal), personal)?.admin).toBeNull();
  });
  it('supports administration without personal Atlas or customer-map permissions', () => {
    const admin = { atlasRead: false, integrationsManage: true, customersRead: false };
    expect(parseLocalReadiness(localReadiness(admin), admin)).toEqual(localReadiness(admin));
    expect(parseLocalReadiness(localReadiness(), admin)).toBeNull();
  });
  it('preserves known mapping issues without treating complete local metadata as incomplete data', () => {
    const value = localReadiness(); const mappings = value.admin!.atlasMappings!;
    mappings.counts!.validLinks--; mappings.counts!.missingReferences++; mappings.reviewStatus = 'REQUIRED';
    expect(parseLocalReadiness(value, authority)?.status).toBe('LOCAL_SNAPSHOT');
  });
  it('labels the 500-link cap as incomplete and requiring review', () => {
    const value = localReadiness(); value.status = 'PARTIAL'; const m = value.admin!.atlasMappings!;
    m.status = 'INCOMPLETE'; m.reviewStatus = 'REQUIRED'; m.coverage = { storedLinks: 501, examinedLinks: 500, omittedLinks: 1, unlinkedStoredReferences: 0 }; m.counts!.validLinks = 500;
    expect(parseLocalReadiness(value, authority)).toEqual(value);
  });
  it.each(['CHANGED', 'UNAVAILABLE'] as const)('accepts %s only with unknown review and no old coverage/counts', status => {
    const value = localReadiness(); value.status = 'PARTIAL'; const m = value.admin!.atlasMappings!;
    m.status = status; m.reviewStatus = 'UNKNOWN'; m.coverage = null; m.counts = null;
    expect(parseLocalReadiness(value, authority)).toEqual(value);
  });
});
