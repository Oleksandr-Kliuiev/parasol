import i18n, { localeOf } from '../../i18n';

export interface ParsedNumber {
  value: number;
  format: (value: number) => string;
}

/**
 * Finds the one number in a formatted value ("NOK 1 234,50", "37,5 t", "12 %", "40") and returns a formatter that puts
 * any other number into the same text with the same decimals and grouping. Dates, times, ranges and "3 of 5" have more
 * than one number or a separator and are left alone.
 */
export function parseFormattedNumber(text: string, locale = localeOf(i18n.language)): ParsedNumber | null {
  if (/[/:]/.test(text)) return null;
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find((part) => part.type === 'group')?.value ?? ',';
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groupClass = group.trim() === '' ? '\\s\\u00A0\\u202F' : escape(group);
  const pattern = new RegExp(`[-\\u2212]?\\d{1,3}(?:[${groupClass}]\\d{3})+(?:${escape(decimal)}\\d+)?|[-\\u2212]?\\d+(?:${escape(decimal)}\\d+)?`, 'g');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const token = match[0];
  const fraction = token.split(decimal)[1]?.length ?? 0;
  const grouped = new RegExp(`\\d[${groupClass}]\\d`).test(token);
  const value = Number(token.replace(/−/, '-').replace(new RegExp(`[${groupClass}]`, 'g'), '').replace(decimal, '.'));
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) return null;
  const formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: fraction, maximumFractionDigits: fraction, useGrouping: grouped });
  const before = text.slice(0, match.index);
  const after = text.slice(match.index! + token.length);
  return { value, format: (current) => `${before}${formatter.format(current)}${after}` };
}

