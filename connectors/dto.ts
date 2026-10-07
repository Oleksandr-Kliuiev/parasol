import { AtlasError } from '../packages/core/contracts.ts';

/**
 * Runtime validation of vendor DTOs (task 1.5). Only the fields Atlas reads are checked; unknown fields are ignored. A
 * mismatch is PERMANENT (no endless retry of a contract change) and names the field, never its value. Vendor text is
 * untrusted: it is bounded and made storable (no control characters, no lone surrogates) before it goes anywhere.
 */
export const contractMismatch = (field: string) => new AtlasError('UPSTREAM_CONTRACT_MISMATCH', 'PERMANENT', { field });
export type JsonObject = Record<string, unknown>;

export function record(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractMismatch(field);
  return value as JsonObject;
}
export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw contractMismatch(field);
  return value;
}
/** Vendor integer ID (int64 in both specs) as a string. Beyond 2^53 JSON parsing would round silently, so it is refused. */
export function id(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw contractMismatch(field);
}
export function optionalId(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : id(value, field);
}
export function count(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw contractMismatch(field);
}
/** Untrusted text: controls become spaces, lone surrogates U+FFFD, whitespace collapsed, bounded by code points. */
export function safeText(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\p{Cs}/gu, '�').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('');
}
export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw contractMismatch(field);
  const text = safeText(value, max);
  return text === '' ? null : text;
}
export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw contractMismatch(field);
  return value as T;
}
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/;
/**
 * ISO-8601 timestamp, returned in UTC. `assumeUtcWithoutOffset` interprets a timestamp without offset as UTC (Atera's
 * export does not state the zone; to be verified against the account, connectors/CONTRACTS.md). Never machine-local time.
 */
export function optionalTime(value: unknown, field: string, assumeUtcWithoutOffset = false): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) throw contractMismatch(field);
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!hasOffset && !assumeUtcWithoutOffset) throw contractMismatch(field);
  const ms = Date.parse(hasOffset ? value : `${value}Z`);
  if (!Number.isFinite(ms)) throw contractMismatch(field);
  return new Date(ms).toISOString();
}
export function requiredTime(value: unknown, field: string, assumeUtcWithoutOffset = false): string {
  const time = optionalTime(value, field, assumeUtcWithoutOffset);
  if (time === null) throw contractMismatch(field);
  return time;
}
