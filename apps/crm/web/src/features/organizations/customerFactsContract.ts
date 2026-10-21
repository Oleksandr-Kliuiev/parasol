import { z } from 'zod';
import { organizationStatuses } from '../../api/types';

const count = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(64);
const money = z.number().finite();

const factsShape = {
  work: z.strictObject({ open: count, overdue: count }).nullable(),
  agreements: z.strictObject({ active: count, nextEnd: day.nullable() }).nullable(),
  hourBanks: z.strictObject({ active: count, remainingHours: z.number().finite(), purchasedHours: z.number().finite().min(0), low: z.boolean() }).nullable(),
  // The two amounts are left out for a role without finance.read, as on the invoice list.
  invoices: z.strictObject({ open: count, overdue: count, outstanding: money.nullable().optional(), overdueAmount: money.nullable().optional() }).nullable(),
};
const factsSchema = z.strictObject(factsShape);
const itemSchema = z.strictObject({ organizationId: id, ...factsShape });
const factsResponse = z.strictObject({ asOf: day, items: z.array(itemSchema).max(50) });

export const attentionReasons = ['OverdueInvoices', 'OverdueWork', 'AgreementEnding', 'HourBankLow'] as const;
const attentionResponse = z.strictObject({
  asOf: day,
  total: count,
  items: z.array(z.strictObject({
    organization: z.strictObject({
      id, name: z.string().min(1).max(256), status: z.enum(organizationStatuses),
      accountManager: z.strictObject({ id, displayName: z.string().max(256) }).nullable(),
    }),
    reasons: z.array(z.enum(attentionReasons)).min(1).max(attentionReasons.length),
    facts: factsSchema,
  })).max(50),
});

export type CustomerFacts = z.infer<typeof factsSchema>;
export type AttentionReason = (typeof attentionReasons)[number];
export type CustomerAttention = z.infer<typeof attentionResponse>;

/**
 * The facts of the customers a page of the list shows (UX 2026, В6). An answer about other ids, a missing or repeated id, or
 * an overdue count above the open count is refused as a whole: the list then shows its rows without facts, never wrong ones.
 */
export function parseCustomerFacts(value: unknown, ids: readonly string[]): { asOf: string; facts: Map<string, CustomerFacts> } | null {
  const parsed = factsResponse.safeParse(value);
  if (!parsed.success || parsed.data.items.length !== ids.length) return null;
  const facts = new Map<string, CustomerFacts>();
  for (const [index, { organizationId, ...item }] of parsed.data.items.entries()) {
    if (organizationId !== ids[index] || facts.has(organizationId) || !consistent(item)) return null;
    facts.set(organizationId, item);
  }
  return { asOf: parsed.data.asOf, facts };
}

/** Who needs attention now, at most 50 with the total: a reason must be backed by the fact it names. */
export function parseCustomerAttention(value: unknown): CustomerAttention | null {
  const parsed = attentionResponse.safeParse(value);
  if (!parsed.success || parsed.data.items.length > parsed.data.total) return null;
  const ids = new Set(parsed.data.items.map((item) => item.organization.id));
  if (ids.size !== parsed.data.items.length) return null;
  const backed = parsed.data.items.every(({ reasons, facts }) => consistent(facts)
    && (!reasons.includes('OverdueInvoices') || (facts.invoices?.overdue ?? 0) > 0)
    && (!reasons.includes('OverdueWork') || (facts.work?.overdue ?? 0) > 0)
    && (!reasons.includes('AgreementEnding') || facts.agreements?.nextEnd != null)
    && (!reasons.includes('HourBankLow') || facts.hourBanks?.low === true));
  return backed ? parsed.data : null;
}

function consistent(facts: CustomerFacts): boolean {
  return (!facts.work || facts.work.overdue <= facts.work.open)
    && (!facts.invoices || facts.invoices.overdue <= facts.invoices.open)
    && (!facts.hourBanks || facts.hourBanks.active > 0 || !facts.hourBanks.low);
}
