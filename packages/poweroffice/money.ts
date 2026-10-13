import { AMOUNT_INTEGER_DIGITS, SUM_INTEGER_DIGITS } from './contracts.ts';

/**
 * Exact money in BigInt minor units (docs/stage4/02_CONTRACTS.md): canonical nonnegative decimal strings with exactly two
 * fractional digits, no sign, exponent, whitespace or leading zero except a single 0. Never floating point; sums never
 * combine currencies or subtract credit notes. Returns null for anything non-canonical (the caller owns the fixed error).
 */
const pattern = (digits: number) => new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})\\.([0-9]{2})$`);
const AMOUNT = pattern(AMOUNT_INTEGER_DIGITS);
const SUM = pattern(SUM_INTEGER_DIGITS);

function parse(value: unknown, re: RegExp): bigint | null {
  if (typeof value !== 'string') return null;
  const match = re.exec(value);
  return match ? BigInt(match[1]!) * 100n + BigInt(match[2]!) : null;
}
/** A normalized invoice amount (at most 15 integer digits). */
export const parseAmount = (value: unknown): bigint | null => parse(value, AMOUNT);
/** An aggregate sum (at most 19 integer digits). */
export const parseSum = (value: unknown): bigint | null => parse(value, SUM);

/** Canonical rendering of a nonnegative sum; null when negative or beyond 19 integer digits. */
export function formatSum(minor: bigint): string | null {
  if (minor < 0n) return null;
  const units = minor / 100n;
  const cents = minor % 100n;
  const text = `${units.toString()}.${cents.toString().padStart(2, '0')}`;
  return SUM.test(text) ? text : null;
}
