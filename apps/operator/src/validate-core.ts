// DOM-free validation primitives. A validator either returns a value of the exact expected shape or throws Invalid; the
// caller turns that into the fixed RESPONSE_INVALID / RESPONSE_TOO_LARGE code. Field names and values are never reported.
import { LIMITS } from './contracts.ts';

export class Invalid extends Error {
  readonly tooLarge: boolean;
  constructor(tooLarge = false) { super(tooLarge ? 'RESPONSE_TOO_LARGE' : 'RESPONSE_INVALID'); this.tooLarge = tooLarge; }
}
export const fail = (): never => { throw new Invalid(); };
export const tooLarge = (): never => { throw new Invalid(true); };

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Json;
}
/** An array of at most `max` entries. A longer one is RESPONSE_TOO_LARGE: never truncated into a partial success. */
export function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) fail();
  if ((value as unknown[]).length > max) tooLarge();
  return value as unknown[];
}
export function string(value: unknown): string {
  if (typeof value !== 'string') fail();
  return value as string;
}
export function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
export function matching(value: unknown, pattern: RegExp): string {
  const text = string(value);
  if (!pattern.test(text)) fail();
  return text;
}
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail();
  return value as T;
}
export function nullableOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null ? null : oneOf(value, allowed);
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value as boolean;
}
export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value as number;
}
export function unitInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value as number;
}
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO-8601 timestamp with an explicit zone, as the accepted API emits (toISOString). */
export function time(value: unknown): string {
  const text = string(value);
  if (!ISO_TIME.test(text) || !Number.isFinite(Date.parse(text))) fail();
  return text;
}
export function nullableTime(value: unknown): string | null {
  return value === null ? null : time(value);
}
/** Non-empty identifier text of bounded length (row IDs whose format the accepted contract does not fix). */
export function identifier(value: unknown): string {
  const text = string(value);
  if (text.length === 0 || text.length > 256) fail();
  return text;
}
export function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

/**
 * Display form of untrusted text: at most LIMITS.displayCodePoints code points, with a visible marker when shortened.
 * Only for display. Identifiers used in requests are always validated and used unshortened.
 */
export function displayText(value: string, max: number = LIMITS.displayCodePoints): { text: string; shortened: boolean } {
  const points = Array.from(value);
  return points.length <= max ? { text: value, shortened: false } : { text: points.slice(0, max).join(''), shortened: true };
}
