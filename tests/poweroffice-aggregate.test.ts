import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SummaryBuilder, validateSummary } from '../packages/poweroffice/aggregate.ts';
import { businessDate, isGregorianDate, parseUtcInstant } from '../packages/poweroffice/calendar.ts';
import { formatSum, parseAmount, parseSum } from '../packages/poweroffice/money.ts';
import type { Invoice } from '../packages/poweroffice/dto.ts';
import { AGGREGATE_CASES } from './support/poweroffice-aggregates.ts';

// S4-A A1: exact BigInt money, Gregorian/UTC/Europe-Oslo calendar rules, grouped aggregation and the strict aggregate
// validator. The adversarial corpus (tests/support/poweroffice-aggregates.ts) is shared with the SQL guard test.
let n = 0;
const inv = (kind: Invoice['kind'], currency: Invoice['currency'], outstanding: string, dueDate = '2026-01-01', gross = outstanding): Invoice =>
  ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, kind, currency, gross, outstanding, dueDate });

test('canonical amounts: exact BigInt minor units, two decimals, no sign/exponent/leading zero/whitespace, bounded digits', () => {
  assert.equal(parseAmount('0.00'), 0n);
  assert.equal(parseAmount('0.10')! + parseAmount('0.20')!, 30n, 'no binary floating point');
  assert.equal(parseAmount('999999999999999.99'), 99999999999999999n);
  for (const bad of ['1000000000000000.00', '1.0', '1.000', '01.00', '-1.00', '+1.00', '1e2', ' 1.00', '1.00 ', '١.٠٠', '1,00', '.50', '1.', '', 1, null]) {
    assert.equal(parseAmount(bad), null, String(bad));
  }
  assert.equal(parseSum('9999999999999999999.99'), 999999999999999999999n);
  assert.equal(parseSum('10000000000000000000.00'), null);
  assert.equal(formatSum(999999999999999999999n), '9999999999999999999.99');
  assert.equal(formatSum(1000000000000000000000n), null, 'beyond 19 integer digits');
  assert.equal(formatSum(-1n), null);
  assert.equal(formatSum(5n), '0.05');
});

test('calendar: real Gregorian dates without Date coercion; exact UTC instants; Europe/Oslo business date across DST and midnight', () => {
  for (const ok of ['2024-02-29', '2000-02-29', '2026-12-31', '0001-01-01']) assert.ok(isGregorianDate(ok), ok);
  for (const bad of ['2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z', '２０２６-01-01', '0000-01-01', 20260101]) {
    assert.ok(!isGregorianDate(bad), String(bad));
  }
  assert.ok(parseUtcInstant('2026-10-24T22:30:00.000Z'));
  for (const bad of ['2026-10-24T22:30:00Z', '2026-10-24T22:30:00.000+02:00', '2026-10-24 22:30:00.000Z', '2026-02-30T00:00:00.000Z', '2026-10-24T24:00:00.000Z']) {
    assert.equal(parseUtcInstant(bad), null, bad);
  }
  const oslo = (iso: string) => businessDate(new Date(iso));
  assert.equal(oslo('2026-10-24T21:59:59.999Z'), '2026-10-24', 'CEST: 23:59:59.999 local');
  assert.equal(oslo('2026-10-24T22:00:00.000Z'), '2026-10-25', 'CEST midnight is 22:00 UTC');
  assert.equal(oslo('2026-10-25T22:59:59.999Z'), '2026-10-25', 'after the October change: CET');
  assert.equal(oslo('2026-10-25T23:00:00.000Z'), '2026-10-26', 'CET midnight is 23:00 UTC');
  assert.equal(oslo('2026-03-28T22:59:59.999Z'), '2026-03-28');
  assert.equal(oslo('2026-03-28T23:00:00.000Z'), '2026-03-29', 'the March change day starts in CET');
  assert.equal(oslo('2026-03-29T21:59:59.999Z'), '2026-03-29');
  assert.equal(oslo('2026-03-29T22:00:00.000Z'), '2026-03-30', 'and ends in CEST');
});

test('aggregation: per currency in lexical order, invoice and credit magnitudes separate, open/overdue against the fixed business date', () => {
  const b = new SummaryBuilder('2026-10-25');
  b.add(inv('INVOICE', 'NOK', '100.00', '2026-10-24'));
  b.add(inv('INVOICE', 'NOK', '0.01', '2026-10-25'));
  b.add(inv('INVOICE', 'NOK', '0.00', '2020-01-01', '50.00'));
  b.add(inv('CREDIT_NOTE', 'NOK', '30.00', '2020-01-01'));
  b.add(inv('INVOICE', 'EUR', '0.10'));
  b.add(inv('INVOICE', 'EUR', '0.20'));
  assert.deepEqual(b.build(), { totalCount: 6, currencies: [
    { currency: 'EUR', count: 2, openInvoiceCount: 2, overdueInvoiceCount: 2, creditNoteCount: 0, outstandingInvoiceAmount: '0.30', outstandingCreditAmount: '0.00' },
    { currency: 'NOK', count: 4, openInvoiceCount: 2, overdueInvoiceCount: 1, creditNoteCount: 1, outstandingInvoiceAmount: '100.01', outstandingCreditAmount: '30.00' }] },
    'due today is not overdue; a paid invoice is neither open nor netted; credits stay separate and never subtract');
  assert.deepEqual(new SummaryBuilder('2026-10-25').build(), { totalCount: 0, currencies: [] }, 'known empty is a value, not null');
  const max = new SummaryBuilder('2026-10-25');
  for (let i = 0; i < 10000; i++) max.add(inv('INVOICE', 'SEK', '999999999999999.99', '2027-01-01'));
  assert.equal(max.build().currencies[0]!.outstandingInvoiceAmount, '9999999999999999900.00', 'exact maximum sum');
});

test('the shared adversarial corpus: validateSummary accepts exactly the valid aggregates', () => {
  for (const c of AGGREGATE_CASES) {
    if (c.valid) assert.deepEqual(validateSummary(c.value), c.value, c.label);
    else assert.throws(() => validateSummary(c.value), /POWEROFFICE_DTO_INVALID/, c.label);
  }
});

test('validated aggregates are detached frozen copies; accessors, prototypes and symbols are refused', () => {
  const source = { totalCount: 1, currencies: [{ currency: 'NOK', count: 1, openInvoiceCount: 1, overdueInvoiceCount: 0, creditNoteCount: 0,
    outstandingInvoiceAmount: '5.00', outstandingCreditAmount: '0.00' }] };
  const valid = validateSummary(source);
  source.currencies[0]!.outstandingInvoiceAmount = '9.99'; source.totalCount = 7; source.currencies.push(source.currencies[0]!);
  assert.equal(valid.totalCount, 1); assert.equal(valid.currencies.length, 1); assert.equal(valid.currencies[0]!.outstandingInvoiceAmount, '5.00');
  assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.currencies) && Object.isFrozen(valid.currencies[0]));
  let reads = 0;
  const getter = { get totalCount() { reads++; return 0; }, currencies: [] };
  assert.throws(() => validateSummary(getter), /POWEROFFICE_DTO_INVALID/); assert.equal(reads, 0, 'an accessor is never invoked');
  assert.throws(() => validateSummary(Object.assign(Object.create({ inherited: 1 }), { totalCount: 0, currencies: [] })), /POWEROFFICE_DTO_INVALID/);
  assert.throws(() => validateSummary({ totalCount: 0, currencies: [], [Symbol('x')]: 1 }), /POWEROFFICE_DTO_INVALID/);
  const sparse: unknown[] = []; sparse.length = 1;
  assert.throws(() => validateSummary({ totalCount: 0, currencies: sparse }), /POWEROFFICE_DTO_INVALID/, 'array holes');
  const tagged = Object.assign([], { extra: 1 });
  assert.throws(() => validateSummary({ totalCount: 0, currencies: tagged }), /POWEROFFICE_DTO_INVALID/, 'array with extra own property');
});
