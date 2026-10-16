import { contractMismatch, safeText } from '../dto.ts';

/**
 * Shared field validators of the Microsoft Graph v1.0 DTOs (Stage 2 task 2.1, docs/stage2/02_CONTRACTS.md §2). Failures
 * are UPSTREAM_CONTRACT_MISMATCH naming the Atlas field only, never the offending value (it may be tenant data).
 * Optional fields: absent/null/empty become null. A present value of the wrong type or shape fails the row, so a
 * malformed page is never stored half-read.
 */
export const M365_MAX_PAGE_ROWS = 500;
/** Cap on the raw string a text field may arrive with; larger input is a contract violation, not something to clean. */
const MAX_RAW_TEXT = 4096;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_GUID = '00000000-0000-0000-0000-000000000000';

/** Reason codes that go with a projected row; fixed vocabulary, never copied vendor text. */
export type M365DtoReason = 'USER_TYPE_UNKNOWN';
export interface M365Parsed<T> { dto: T; reasons: readonly M365DtoReason[] }

/** Directory object or tenant GUID, canonical lower case so that exact comparison is case-stable. */
export function requiredGuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw contractMismatch(field);
  const guid = value.toLowerCase();
  if (guid === NIL_GUID) throw contractMismatch(field);
  return guid;
}
/**
 * Optional reference ID: empty string or null → null. The all-zero GUID is Graph's "no object" placeholder and also
 * becomes null, so two unrelated rows can never match on it.
 */
export function optionalGuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !GUID.test(value)) throw contractMismatch(field);
  const guid = value.toLowerCase();
  return guid === NIL_GUID ? null : guid;
}
/** Opaque vendor ID (sign-in id): kept exactly as sent, nonempty, bounded, no control characters or lone surrogates. */
export function requiredOpaqueId(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f\p{Cs}]/u.test(value)) throw contractMismatch(field);
  return value;
}
/** Display text: cleaned and truncated to `max` code points; empty → null. Input beyond the raw cap fails. */
export function boundedText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_RAW_TEXT) throw contractMismatch(field);
  const text = safeText(value, max);
  return text === '' ? null : text;
}
export function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw contractMismatch(field);
  return value;
}
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/;
/**
 * Strict UTC instant: `Z` suffix required (no offset, no zone-less form), and every component must be a real calendar
 * value. `Date.parse` alone would roll 2026-02-30 over to March and accept 24:00, so the parsed date is compared back
 * to its components. The sub-second digits are kept as sent (the source time is evidence that gets content-hashed):
 * canonical text has at least three digits (`.000`) and no trailing zeros beyond the third, so `.5`, `.50` and `.500`
 * are one value while `.1234567` and `.1234568` stay distinct.
 */
export function requiredUtcTime(value: unknown, field: string): string {
  const m = typeof value === 'string' ? UTC_TIME.exec(value) : null;
  if (!m) throw contractMismatch(field);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (year < 1000) throw contractMismatch(field); // Date.UTC maps years 0–99 to 1900–1999
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw contractMismatch(field);
  const fraction = (m[7] ?? '').padEnd(3, '0').replace(/(?<=\d{3})0+$/, '');
  return `${date.toISOString().slice(0, 19)}.${fraction}Z`;
}
