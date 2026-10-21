import { describe, expect, it } from 'vitest';
import { parseCustomerAttention, parseCustomerFacts } from './customerFactsContract';

const facts = (overdue = 1) => ({ work: { open: 2, overdue }, agreements: { active: 1, nextEnd: '2026-11-10' },
  hourBanks: { active: 1, remainingHours: 6, purchasedHours: 40, low: true }, invoices: { open: 2, overdue: 1 } });

describe('customer facts (UX 2026, В6)', () => {
  it('reads one item per asked id, in order, without the amounts a role may not see', () => {
    const parsed = parseCustomerFacts({ asOf: '2026-10-21', items: [{ organizationId: 'a', ...facts() }, { organizationId: 'b', work: null, agreements: null, hourBanks: null, invoices: null }] }, ['a', 'b']);
    expect(parsed?.facts.get('a')?.invoices).toEqual({ open: 2, overdue: 1 });
    expect(parsed?.facts.get('b')?.work).toBeNull();
  });

  it.each([
    ['another id', { asOf: '2026-10-21', items: [{ organizationId: 'x', ...facts() }] }, ['a']],
    ['a missing id', { asOf: '2026-10-21', items: [] }, ['a']],
    ['more overdue than open', { asOf: '2026-10-21', items: [{ organizationId: 'a', ...facts(3) }] }, ['a']],
    ['an unknown field', { asOf: '2026-10-21', items: [{ organizationId: 'a', ...facts(), token: 'x' }] }, ['a']],
  ])('refuses the whole answer for %s', (_, value, ids) => expect(parseCustomerFacts(value, ids)).toBeNull());

  it('refuses an attention reason the facts do not back, and more items than the total', () => {
    const item = (reasons: string[], overdue = 1) => ({ organization: { id: 'a', name: 'Fjord IT AS', status: 'Customer', accountManager: null }, reasons, facts: facts(overdue) });
    expect(parseCustomerAttention({ asOf: '2026-10-21', total: 1, items: [item(['OverdueWork'])] })).not.toBeNull();
    expect(parseCustomerAttention({ asOf: '2026-10-21', total: 1, items: [item(['OverdueWork'], 0)] })).toBeNull();
    expect(parseCustomerAttention({ asOf: '2026-10-21', total: 0, items: [item(['OverdueWork'])] })).toBeNull();
  });
});
