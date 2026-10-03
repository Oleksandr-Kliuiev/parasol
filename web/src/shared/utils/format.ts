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
