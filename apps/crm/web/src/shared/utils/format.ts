import i18n, { localeOf } from '../../i18n';

const TIME_ZONE = 'Europe/Oslo';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(localeOf(i18n.language), { dateStyle: 'short', timeZone: TIME_ZONE }).format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(localeOf(i18n.language), { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE }).format(
    new Date(iso),
  );
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a moment was, in the interface language: "19 days ago", "for 19 dagar sidan". Lists show the age a person
 * triages by; the exact moment stays available as the element's title and in the record's own view. The phrases are our
 * own strings, not Intl.RelativeTimeFormat: browsers without Nynorsk data would answer in Bokmål (or say "døgn" in one
 * engine and "dager" in another). A moment in the future (a clock ahead of ours) reads as "just now".
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < MINUTE) return i18n.t('relativeTime.justNow');
  if (seconds < HOUR) return i18n.t('relativeTime.minutes', { count: Math.floor(seconds / MINUTE) });
  if (seconds < DAY) return i18n.t('relativeTime.hours', { count: Math.floor(seconds / HOUR) });
  if (seconds < 30 * DAY) return i18n.t('relativeTime.days', { count: Math.floor(seconds / DAY) });
  if (seconds < 365 * DAY) return i18n.t('relativeTime.months', { count: Math.floor(seconds / (30 * DAY)) });
  return i18n.t('relativeTime.years', { count: Math.floor(seconds / (365 * DAY)) });
}

/** A reading time in a status line: only the clock for today in Oslo, otherwise the short date and the clock. */
export function formatReadAt(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const day = (value: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(value);
  const moment = new Date(iso);
  if (day(moment) !== day(now)) return formatDateTime(iso);
  return new Intl.DateTimeFormat(localeOf(i18n.language), { timeStyle: 'short', timeZone: TIME_ZONE }).format(moment);
}

export function formatAddress(address: { street: string | null; postalCode: string | null; city: string | null } | null | undefined): string {
  if (!address) return '';
  const place = [address.postalCode, address.city].filter(Boolean).join(' ');
  return [address.street, place].filter(Boolean).join(', ');
}

export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function formatMoney(value: number | null | undefined, currency = 'NOK'): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat(localeOf(i18n.language), { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 2): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat(localeOf(i18n.language), { maximumFractionDigits }).format(value);
}

/** Today's date in Oslo as yyyy-MM-dd, the format of DateOnly values in the API. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(new Date());
}

/** Parses a number typed with either decimal comma or point; empty input gives null. */
export function parseDecimal(value: string): number | null {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * A formatted amount that may wrap between the currency and the number, never inside the number ("NOK" over
 * "1 234 567", "1 234 567" over "kr"): Intl joins them with a no-break space, so a narrow tile would split the digits.
 */
export const wrapAtCurrency = (amount: string) => amount.replace(/^([^\d\s-]+)\u00a0/u, '$1 ').replace(/\u00a0([^\d\s]+)$/u, ' $1');
