import { z } from 'zod';
export const findingCodes = ['SAVED_REVIEW_NOTE', 'PERIOD_CLOSED', 'BANK_HISTORY_UNPROVEN', 'BANK_PENDING_APPROVAL',
  'BANK_ALLOCATION_MISMATCH', 'BANK_REFERENCE_UNAVAILABLE', 'BILLING_SOURCE_UNPROVEN', 'BILLING_PROTECTED', 'PARTIAL_EXPORT'] as const;
// CRM uses SQL-sortable GUIDs whose version/variant bytes are not RFC UUID markers (SequentialId.New).
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .refine(v => v !== '00000000-0000-0000-0000-000000000000');
const hours = z.number().finite();
const count = z.number().int().nonnegative();
const schema = z.strictObject({
  schemaVersion: z.literal(1), entryId: id, organizationId: id, organizationName: z.string().nullable(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hours: hours.positive(),
  status: z.enum(['New', 'Approved', 'NonBillable', 'Invoiced']), approvalCount: count,
  reviewNote: z.string().nullable(), periodClosed: z.boolean(), etag: z.string().min(1),
  checkedAt: z.iso.datetime({ offset: true }), requiresReview: z.boolean(),
  findings: z.array(z.strictObject({ code: z.enum(findingCodes), level: z.enum(['Info', 'Review']) })),
  banks: z.array(z.strictObject({ bankId: id, name: z.string().nullable(),
    state: z.enum(['Active', 'Closed', 'Missing', 'OtherOrganization', 'Deleted']), available: z.boolean(),
    allocatedHours: hours, consumedHours: hours, returnedHours: hours, netHours: hours, receipts: count })),
  billing: z.array(z.strictObject({ basisId: id, exported: z.boolean(), proven: z.boolean(), currentRevision: z.boolean(), matchedAllocations: count })),
});
export type FinancialReview = z.infer<typeof schema>;

export function parseFinancialReview(value: unknown, entryId: string): FinancialReview {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid saved financial review.');
  const data = parsed.data;
  if (data.entryId !== entryId || data.requiresReview !== data.findings.some(f => f.level === 'Review')
    || new Set(data.findings.map(f => f.code)).size !== data.findings.length
    || new Set(data.banks.map(b => b.bankId)).size !== data.banks.length
    || new Set(data.billing.map(b => b.basisId)).size !== data.billing.length
    || data.banks.some(b => b.available !== ['Active', 'Closed'].includes(b.state))) throw new Error('Invalid saved financial review.');
  return data;
}
