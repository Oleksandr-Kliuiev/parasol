import type { FinancialReview } from './financialReviewContract';

export const reviewEntryId = '11111111-1111-4111-8111-111111111111';
export function financialReviewFixture(entryId = reviewEntryId): FinancialReview {
  return { schemaVersion: 1, entryId, organizationId: '22222222-2222-4222-8222-222222222222', organizationName: 'Synthetic review customer',
    workDate: '2026-10-17', hours: 2, status: 'Approved', approvalCount: 1, reviewNote: null, periodClosed: false,
    etag: '"synthetic-version"', checkedAt: '2026-10-17T12:00:00Z', requiresReview: false, findings: [],
    banks: [{ bankId: '33333333-3333-4333-8333-333333333333', name: 'Synthetic review bank', state: 'Active', available: true,
      allocatedHours: 2, consumedHours: 2, returnedHours: 0, netHours: 2, receipts: 1 }],
    billing: [{ basisId: '44444444-4444-4444-8444-444444444444', exported: false, proven: true, currentRevision: true, matchedAllocations: 1 }] };
}
