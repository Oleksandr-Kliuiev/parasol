import { BUSINESS_TIME_ZONE } from './contracts.ts';

/**
 * Calendar rules of the normalized export (docs/stage4/02_CONTRACTS.md). Dates are proleptic Gregorian YYYY-MM-DD checked
 * arithmetically (no Date parsing or local-runtime timezone coercion). Instants are exact UTC ISO strings with milliseconds.
 * The business date is the Europe/Oslo calendar date of the claim's DB asOf, from IANA tzdata (Intl), fixed per export.
 */
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$/;

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** A real Gregorian calendar date, years 0001–9999. */
export function isGregorianDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** An exact UTC instant `YYYY-MM-DDTHH:mm:ss.sssZ` (the toISOString form); null otherwise. */
export function parseUtcInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = INSTANT.exec(value);
  if (!m || !isGregorianDate(`${m[1]}-${m[2]}-${m[3]}`)) return null;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (h > 23 || mi > 59 || s > 59 || Number(m[1]) < 1970) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

const oslo = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' });
/** The Europe/Oslo calendar date (YYYY-MM-DD) of an instant, independent of the process time zone. */
export function businessDate(instant: Date): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new RangeError('invalid instant');
  const parts = Object.fromEntries(oslo.formatToParts(instant).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (!isGregorianDate(date)) throw new RangeError('invalid business date');
  return date;
}
