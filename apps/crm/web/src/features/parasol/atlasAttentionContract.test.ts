import { describe, expect, it } from 'vitest';
import { atlasAttention } from '../../test/atlasAttention';
import { parseAtlasAttention, type AtlasAttentionView } from './atlasAttentionContract';

describe('the closed personal attention projection', () => {
  it('accepts bounded previews with full ready-customer counts and explicit failures/gaps', () => {
    const value = atlasAttention(); expect(parseAtlasAttention(value)).toEqual(value);
    expect(value.customers![0]!.preview).toHaveLength(3); expect(value.totals!.high + value.totals!.critical).toBe(6);
  });

  it('preserves canonical CRM COMB GUIDs without requiring RFC UUID version or variant bits', () => {
    // SequentialId.New() combines random bytes and a counter/timestamp without setting RFC UUID bits.
    const customerId = '12345678-90ab-0abc-0000-1234567890ab';
    const value = atlasAttention(customerId); const parsed = parseAtlasAttention(value);
    expect(parsed.status).toBe('PARTIAL'); expect(parsed.customers![0]!.customerId).toBe(customerId);
  });

  it.each([
    ['unknown root field', (v: AtlasAttentionView) => { Object.assign(v, { token: 'synthetic-private' }); }],
    ['unknown customer field', (v: AtlasAttentionView) => { Object.assign(v.customers![0]!, { rawPayload: {} }); }],
    ['unknown resource field', (v: AtlasAttentionView) => { Object.assign(v.customers![0]!.resources![0]!, { secretRef: 'synthetic-private' }); }],
    ['missing coverage', (v: AtlasAttentionView) => { v.coverage = null; }],
    ['wrong visible count', (v: AtlasAttentionView) => { v.coverage!.visibleClients++; }],
    ['wrong selected count', (v: AtlasAttentionView) => { v.coverage!.selectedCustomers--; }],
    ['wrong ready count', (v: AtlasAttentionView) => { v.coverage!.readyCustomers++; v.coverage!.failedCustomers--; }],
    ['attempted below ready', (v: AtlasAttentionView) => { v.coverage!.attemptedCustomers = 0; }],
    ['incorrect limit flag', (v: AtlasAttentionView) => { v.coverage!.limitReached = true; }],
    ['wrong total', (v: AtlasAttentionView) => { v.totals!.activeObservations++; }],
    ['wrong critical total', (v: AtlasAttentionView) => { v.totals!.critical++; }],
    ['duplicate customer', (v: AtlasAttentionView) => { v.customers![1]!.customerId = v.customers![0]!.customerId; }],
    ['non-GUID customer', (v: AtlasAttentionView) => { v.customers![0]!.customerId = '../customer'; }],
    ['malformed canonical GUID', (v: AtlasAttentionView) => { v.customers![0]!.customerId = '12345678-90ab-0abc-0000-1234567890az'; }],
    ['invalid date', (v: AtlasAttentionView) => { v.customers![0]!.retrievedAt = 'yesterday'; }],
    ['low preview', (v: AtlasAttentionView) => { v.customers![0]!.preview[0]!.severity = 'LOW'; }],
    ['terminal preview', (v: AtlasAttentionView) => { v.customers![0]!.preview[0]!.status = 'RESOLVED'; }],
    ['nonurgent critical', (v: AtlasAttentionView) => { v.customers![0]!.preview[0]!.priority = 'NORMAL'; }],
    ['too few preview records', (v: AtlasAttentionView) => { v.customers![0]!.preview.pop(); }],
    ['too many preview records', (v: AtlasAttentionView) => { v.customers![0]!.preview.push(v.customers![0]!.preview[0]!); }],
    ['missing confirmed device', (v: AtlasAttentionView) => { v.customers![0]!.devices = []; }],
    ['unreferenced device', (v: AtlasAttentionView) => { v.customers![0]!.devices.push({ id: 'other-device', hostname: 'Synthetic other host', sources: [] }); }],
    ['wrong confirmed source', (v: AtlasAttentionView) => { v.customers![0]!.devices[0]!.sources = ['huntress']; }],
    ['partial source called READY', (v: AtlasAttentionView) => { v.status = 'READY'; }],
    ['failed row with old details', (v: AtlasAttentionView) => { v.customers![1]!.preview = v.customers![0]!.preview; }],
    ['denied row salvaged beside ready data', (v: AtlasAttentionView) => { v.customers![1]!.status = 'ACCESS_DENIED'; }],
    ['fatal result retaining totals', (v: AtlasAttentionView) => { v.status = 'ACCESS_DENIED'; v.customers = null; }],
  ])('rejects the entire aggregate for %s', (_, mutate) => {
    const value = atlasAttention(); mutate(value); const parsed = parseAtlasAttention(value);
    expect(parsed.status).toBe('INVALID_RESPONSE'); expect(parsed.customers).toBeNull(); expect(parsed.totals).toBeNull();
  });

  it('accepts zero ready customers as an honest partial read rather than healthy coverage', () => {
    const value = atlasAttention(); value.customers![0] = { ...value.customers![1]!, customerId: value.customers![0]!.customerId };
    value.coverage!.readyCustomers = 0; value.coverage!.failedCustomers = 2;
    value.totals = { activeObservations: 0, high: 0, critical: 0 };
    expect(parseAtlasAttention(value).status).toBe('PARTIAL');
  });

  it('accepts a fully read empty directory without claiming source health', () => {
    const value = atlasAttention(); value.status = 'READY'; value.customers = [];
    value.coverage = { visibleClients: 0, matchedCustomers: 0, selectedCustomers: 0, attemptedCustomers: 0,
      readyCustomers: 0, failedCustomers: 0, omittedCustomers: 0, unmappedClients: 0, mappingIssues: 0, limitReached: false, timedOut: false };
    value.totals = { activeObservations: 0, high: 0, critical: 0 };
    expect(parseAtlasAttention(value)).toEqual(value);
  });

  it.each(['NOT_CONFIGURED', 'ACCESS_DENIED', 'UNAVAILABLE', 'INVALID_RESPONSE'] as const)('accepts a fatal %s without technical rows or totals', status => {
    const value = atlasAttention(); value.status = status; value.customers = null; value.totals = null;
    expect(parseAtlasAttention(value)).toEqual(value); value.coverage = null; expect(parseAtlasAttention(value)).toEqual(value);
  });
});
