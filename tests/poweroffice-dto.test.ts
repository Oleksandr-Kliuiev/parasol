import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHeader, validateInvoice, validatePage } from '../packages/poweroffice/dto.ts';
import { ExportAccumulator } from '../packages/poweroffice/export.ts';

// S4-A A1: strict normalized DTOs (exact keys, types, Unicode/UUID/date/money/currency/sign/scale/overflow), detached frozen
// values, and the complete-export rules across pages. Fixed codes only: DTO_INVALID per object, EXPORT_INCOMPLETE across pages.
const COMPANY = 'synthetic-po-00000000-0000-4000-8000-000000000001';
const AS_OF = '2026-10-24T22:30:00.000Z';
const PINS = { companyKey: COMPANY, asOf: AS_OF };
const EXPORT = 'aaaaaaaa-1111-4111-8111-11111111111b';
const header = (over: Record<string, unknown> = {}) => ({ synthetic: true, companyKey: COMPANY, exportId: EXPORT, asOf: AS_OF, totalCount: 1, ...over });
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const invoice = (over: Record<string, unknown> = {}) => ({ id: id(), kind: 'INVOICE', currency: 'NOK', gross: '100.00', outstanding: '40.00', dueDate: '2026-10-24', ...over });
const page = (ordinal: number, items: unknown[], hasMore: boolean, h: Record<string, unknown> = {}) => ({ header: header(h), ordinal, items, hasMore });

test('header: synthetic marker, exact claim pins (bound company key, claim asOf), UUID export ID, totalCount 0..10000', () => {
  assert.deepEqual(validateHeader(header(), PINS), header());
  for (const [label, over] of [['synthetic false', { synthetic: false }], ['synthetic string', { synthetic: 'true' }],
    ['another company', { companyKey: 'synthetic-po-00000000-0000-4000-8000-000000000002' }], ['real-looking org number', { companyKey: '912345678' }],
    ['other asOf', { asOf: '2026-10-24T22:30:00.001Z' }], ['asOf with offset', { asOf: '2026-10-25T00:30:00.000+02:00' }],
    ['upper-case UUID', { exportId: EXPORT.toUpperCase() }], ['count 10001', { totalCount: 10001 }], ['count -1', { totalCount: -1 }],
    ['count 1.5', { totalCount: 1.5 }], ['count string', { totalCount: '1' }], ['count NaN', { totalCount: Number.NaN }]] as const) {
    assert.throws(() => validateHeader(header(over), PINS), /POWEROFFICE_DTO_INVALID/, label);
  }
  assert.throws(() => validateHeader({ ...header(), next: 'https://example.invalid' }, PINS), /POWEROFFICE_DTO_INVALID/, 'extra field (a next link)');
  const { totalCount: _t, ...missing } = header();
  assert.throws(() => validateHeader(missing, PINS), /POWEROFFICE_DTO_INVALID/, 'missing field');
});

test('invoice: UUID, kind, currency, canonical gross/outstanding with outstanding <= gross, Gregorian due date; no extra or private fields', () => {
  const ok = invoice();
  assert.deepEqual(validateInvoice(ok), ok);
  for (const [label, over] of [['uppercase UUID', { id: 'AAAAAAAA-0000-4000-8000-000000000001' }], ['non-UUID', { id: 'INV-1001' }],
    ['kind', { kind: 'PAYMENT' }], ['currency lower', { currency: 'nok' }], ['currency unknown', { currency: 'CHF' }],
    ['overpayment', { outstanding: '100.01' }], ['negative', { outstanding: '-1.00' }], ['three decimals', { gross: '100.000' }],
    ['16 integer digits', { gross: '1000000000000000.00' }], ['number amount', { gross: 100 }], ['exponent', { gross: '1e2' }],
    ['due date 31 Apr', { dueDate: '2026-04-31' }], ['due date 29 Feb 2026', { dueDate: '2026-02-29' }], ['date-time', { dueDate: '2026-10-24T00:00:00Z' }],
    ['lone surrogate', { currency: 'NO\ud800' }], ['zero-width', { id: `${id()}​` }]] as const) {
    assert.throws(() => validateInvoice(invoice(over)), /POWEROFFICE_DTO_INVALID/, label);
  }
  for (const extra of ['customerName', 'organizationNumber', 'invoiceNumber', 'email', 'lines']) {
    assert.throws(() => validateInvoice({ ...invoice(), [extra]: 'x' }), /POWEROFFICE_DTO_INVALID/, extra);
  }
  assert.deepEqual(validateInvoice(invoice({ dueDate: '2024-02-29', outstanding: '100.00' })).dueDate, '2024-02-29');
});

test('page: header, ordinal 1..100, 0..100 items, boolean hasMore; values are detached and frozen', () => {
  const items = [invoice()];
  const raw = page(1, items, false);
  const valid = validatePage(raw, PINS);
  (items[0] as Record<string, unknown>).outstanding = '99.00'; items.push(invoice()); (raw.header as Record<string, unknown>).totalCount = 5;
  assert.equal(valid.items.length, 1); assert.equal(valid.items[0]!.outstanding, '40.00'); assert.equal(valid.header.totalCount, 1);
  assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.items) && Object.isFrozen(valid.items[0]) && Object.isFrozen(valid.header));
  for (const [label, bad] of [['ordinal 0', page(0, [], false)], ['ordinal 101', page(101, [], false)], ['hasMore string', page(1, [], 'false' as never)],
    ['101 items', page(1, Array.from({ length: 101 }, () => invoice()), true)], ['items object', { ...page(1, [], false), items: {} }]] as const) {
    assert.throws(() => validatePage(bad, PINS), /POWEROFFICE_DTO_INVALID/, label);
  }
});

test('complete export: identical header, contiguous ordinals, full non-final pages, no duplicate IDs, exact final count; first failure poisons', () => {
  const full = () => Array.from({ length: 100 }, () => invoice());
  const ok = new ExportAccumulator(PINS);
  assert.equal(ok.businessDate, '2026-10-25', 'Oslo date of the claim asOf');
  assert.equal(ok.accept(page(1, full(), true, { totalCount: 150 })), false);
  assert.throws(() => ok.summary(), /POWEROFFICE_EXPORT_INCOMPLETE/, 'no partial summary');
  assert.equal(ok.accept(page(2, Array.from({ length: 50 }, () => invoice()), false, { totalCount: 150 })), true);
  assert.equal(ok.summary().totalCount, 150);
  assert.throws(() => ok.accept(page(3, [], false, { totalCount: 150 })), /POWEROFFICE_EXPORT_INCOMPLETE/, 'nothing after the final page');
  const empty = new ExportAccumulator(PINS);
  assert.equal(empty.accept(page(1, [], false, { totalCount: 0 })), true);
  assert.deepEqual(empty.summary(), { totalCount: 0, currencies: [] });
  const dup = invoice();
  const failing: [string, unknown[], RegExp][] = [
    ['changed export ID', [page(1, full(), true, { totalCount: 101 }), page(2, [invoice()], false, { totalCount: 101, exportId: '22222222-2222-4222-8222-222222222222' })], /INCOMPLETE/],
    ['changed totalCount', [page(1, full(), true, { totalCount: 101 }), page(2, [invoice()], false, { totalCount: 102 })], /INCOMPLETE/],
    ['changed company', [page(1, full(), true, { totalCount: 101 }), page(2, [invoice()], false, { totalCount: 101, companyKey: 'synthetic-po-00000000-0000-4000-8000-000000000002' })], /DTO_INVALID/],
    ['gap in ordinals', [page(1, full(), true, { totalCount: 101 }), page(3, [invoice()], false, { totalCount: 101 })], /INCOMPLETE/],
    ['repeated page', [page(1, full(), true, { totalCount: 101 }), page(1, [invoice()], false, { totalCount: 101 })], /INCOMPLETE/],
    ['short non-final page', [page(1, [invoice()], true, { totalCount: 2 })], /INCOMPLETE/],
    ['empty final page after data', [page(1, full(), true, { totalCount: 100 }), page(2, [], false, { totalCount: 100 })], /INCOMPLETE/],
    ['empty final page for a non-empty total', [page(1, [], false, { totalCount: 1 })], /INCOMPLETE/],
    ['duplicate ID across pages', [page(1, [...full().slice(0, 99), dup], true, { totalCount: 101 }), page(2, [{ ...dup }], false, { totalCount: 101 })], /INCOMPLETE/],
    ['final count short', [page(1, [invoice()], false, { totalCount: 2 })], /INCOMPLETE/],
    ['more than totalCount', [page(1, [invoice(), invoice()], false, { totalCount: 1 })], /INCOMPLETE/],
    ['hasMore after the total', [page(1, full(), true, { totalCount: 100 })], /INCOMPLETE/],
    ['malformed item', [page(1, [invoice({ currency: 'XXX' })], false)], /DTO_INVALID/],
  ];
  for (const [label, pages, code] of failing) {
    const acc = new ExportAccumulator(PINS);
    const run = () => { for (const p of pages) acc.accept(p); };
    assert.throws(run, code, label);
    assert.throws(() => acc.summary(), /POWEROFFICE_EXPORT_INCOMPLETE/, `${label}: no summary`);
    assert.throws(() => acc.accept(page(1, [invoice()], false)), /POWEROFFICE_EXPORT_INCOMPLETE/, `${label}: poisoned`);
  }
});

test('bounds: 100 pages / 10000 IDs is the maximum complete export; the claim pins are fixed for every page', () => {
  const acc = new ExportAccumulator(PINS);
  for (let p = 1; p <= 100; p++) acc.accept(page(p, Array.from({ length: 100 }, () => invoice()), p < 100, { totalCount: 10000 }));
  assert.equal(acc.summary().totalCount, 10000);
  assert.throws(() => new ExportAccumulator({ companyKey: COMPANY, asOf: '2026-10-24T22:30:00Z' }), /POWEROFFICE_DTO_INVALID/, 'a claim asOf is an exact instant');
  const pinned = new ExportAccumulator(PINS);
  assert.throws(() => pinned.accept(page(1, [invoice()], false, { asOf: '2026-10-24T22:31:00.000Z' })), /POWEROFFICE_DTO_INVALID/, 'asOf is supplied by the claim');
});

test('dispose ends an incomplete export permanently: no duplicate or otherwise valid later page, no summary; repeated disposal is harmless', () => {
  const first = Array.from({ length: 100 }, () => invoice({ outstanding: '1.00', gross: '1.00' }));
  const acc = new ExportAccumulator(PINS);
  assert.equal(acc.accept(page(1, first, true, { totalCount: 101 })), false);
  acc.dispose(); acc.dispose();
  assert.throws(() => acc.accept(page(2, [{ ...first[0]! }], false, { totalCount: 101 })), /POWEROFFICE_EXPORT_INCOMPLETE/, 'reused ID after dispose');
  assert.throws(() => acc.summary(), /POWEROFFICE_EXPORT_INCOMPLETE/);
  const other = new ExportAccumulator(PINS);
  other.accept(page(1, Array.from({ length: 100 }, () => invoice()), true, { totalCount: 101 }));
  other.dispose();
  assert.throws(() => other.accept(page(2, [invoice()], false, { totalCount: 101 })), /POWEROFFICE_EXPORT_INCOMPLETE/, 'a fresh valid final page too');
  assert.throws(() => other.summary(), /POWEROFFICE_EXPORT_INCOMPLETE/);
  assert.equal(other.complete, false);
  // A completed export keeps its frozen summary through internal cleanup and any disposal; it accepts nothing more.
  const done = new ExportAccumulator(PINS);
  assert.equal(done.accept(page(1, [invoice({ outstanding: '2.50', gross: '3.00' })], false)), true);
  const summary = done.summary();
  done.dispose(); done.dispose();
  assert.equal(done.summary(), summary);
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.currencies[0]));
  assert.equal(summary.currencies[0]!.outstandingInvoiceAmount, '2.50');
  assert.throws(() => done.accept(page(2, [invoice()], false)), /POWEROFFICE_EXPORT_INCOMPLETE/);
});
