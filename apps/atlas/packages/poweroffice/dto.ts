import { MAX_PAGES, MAX_TOTAL_COUNT, PAGE_SIZE, POWEROFFICE_CURRENCIES, SYNTHETIC_COMPANY_PATTERN, UUID_PATTERN, powerOfficeError } from './contracts.ts';
import type { InvoiceKind, PowerOfficeCurrency } from './contracts.ts';
import { isGregorianDate, parseUtcInstant } from './calendar.ts';
import { parseAmount } from './money.ts';

/**
 * Strict whitelist validation of the Atlas-normalized export DTOs (docs/stage4/02_CONTRACTS.md "Internal normalized DTO").
 * Not vendor wire schemas. Every object must be a plain data object with exactly the listed own keys (no symbol, accessor,
 * prototype trick or extra field); every value is read once and copied into a new frozen object, so later mutation of the
 * caller's input cannot change a validated value. Any violation is POWEROFFICE_DTO_INVALID with no detail.
 */
export interface ExportHeader {
  readonly synthetic: true; readonly companyKey: string; readonly exportId: string; readonly asOf: string; readonly totalCount: number;
}
export interface Invoice {
  readonly id: string; readonly kind: InvoiceKind; readonly currency: PowerOfficeCurrency; readonly gross: string; readonly outstanding: string;
  readonly dueDate: string;
}
export interface ExportPage { readonly header: ExportHeader; readonly ordinal: number; readonly items: readonly Invoice[]; readonly hasMore: boolean }

const invalid = () => powerOfficeError('POWEROFFICE_DTO_INVALID');

/** Own enumerable data properties of a plain object with exactly `keys`, each read once. */
export function readRecord(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) throw invalid();
  const out = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    out.set(key, descriptor.value);
  }
  return out;
}
/** Elements of a real dense array of at most `max` items, each read once. */
export function readArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || length > max) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== length + 1) throw invalid();
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    out.push(descriptor.value);
  }
  return out;
}
export const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export interface HeaderPins { companyKey: string; asOf: string }
/** Header with the exact pins of the claim: the bound synthetic company and the claim's asOf. */
export function validateHeader(raw: unknown, pins: HeaderPins): ExportHeader {
  const r = readRecord(raw, ['synthetic', 'companyKey', 'exportId', 'asOf', 'totalCount']);
  const [synthetic, companyKey, exportId, asOf, totalCount] = ['synthetic', 'companyKey', 'exportId', 'asOf', 'totalCount'].map(k => r.get(k));
  if (synthetic !== true || typeof companyKey !== 'string' || !SYNTHETIC_COMPANY_PATTERN.test(companyKey) || companyKey !== pins.companyKey
    || typeof exportId !== 'string' || !UUID_PATTERN.test(exportId) || typeof asOf !== 'string' || parseUtcInstant(asOf) === null
    || asOf !== pins.asOf || !isCount(totalCount, 0, MAX_TOTAL_COUNT)) throw invalid();
  return Object.freeze({ synthetic: true, companyKey, exportId, asOf, totalCount });
}

const CURRENCIES: readonly string[] = POWEROFFICE_CURRENCIES;
export function validateInvoice(raw: unknown): Invoice {
  const r = readRecord(raw, ['id', 'kind', 'currency', 'gross', 'outstanding', 'dueDate']);
  const [id, kind, currency, gross, outstanding, dueDate] = ['id', 'kind', 'currency', 'gross', 'outstanding', 'dueDate'].map(k => r.get(k));
  const g = parseAmount(gross); const o = parseAmount(outstanding);
  if (typeof id !== 'string' || !UUID_PATTERN.test(id) || (kind !== 'INVOICE' && kind !== 'CREDIT_NOTE')
    || typeof currency !== 'string' || !CURRENCIES.includes(currency) || g === null || o === null || o > g || !isGregorianDate(dueDate)) throw invalid();
  return Object.freeze({ id, kind, currency: currency as PowerOfficeCurrency, gross: gross as string, outstanding: outstanding as string, dueDate });
}

/** One page: header with the claim pins, ordinal 1..100, 0..100 invoices and hasMore. Cross-page rules: export.ts. */
export function validatePage(raw: unknown, pins: HeaderPins): ExportPage {
  const r = readRecord(raw, ['header', 'ordinal', 'items', 'hasMore']);
  const ordinal = r.get('ordinal'); const hasMore = r.get('hasMore');
  if (!isCount(ordinal, 1, MAX_PAGES) || typeof hasMore !== 'boolean') throw invalid();
  const header = validateHeader(r.get('header'), pins);
  const items = Object.freeze(readArray(r.get('items'), PAGE_SIZE).map(validateInvoice));
  return Object.freeze({ header, ordinal, items, hasMore });
}
