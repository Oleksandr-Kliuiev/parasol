/**
 * Closed scalar bounds of the R-EVAL server contracts (docs/stage5/ask/remote/reval-server/01 "Common scalar bounds",
 * rs-a/IMPLEMENTATION_BRIEF.md). Every check is exact: no trimming, no case folding, no numeric coercion. Dec64 values are
 * canonical unsigned decimal STRINGS parsed with BigInt only. Objects are closed: exactly the specified own keys.
 */
export class RevalShapeError extends Error {
  constructor() { super('REVAL_SHAPE_INVALID'); this.name = 'RevalShapeError'; }
}
export const shapeFail = (): never => { throw new RevalShapeError(); };

export const DEC64_MAX = 9223372036854775807n;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEC = /^(0|[1-9][0-9]{0,18})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PRICE_REVISION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const DB_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID4.test(v);
export const isScopeId = (v: unknown): v is string => typeof v === 'string' && SCOPE_ID.test(v);
export const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST.test(v);
export const isEvidenceRef = (v: unknown): v is string => typeof v === 'string' && EVIDENCE_REF.test(v);
export const isPriceRevision = (v: unknown): v is string => typeof v === 'string' && PRICE_REVISION.test(v);
export const isRoleName = (v: unknown): v is string => typeof v === 'string' && ROLE.test(v);
export const isDbName = (v: unknown): v is string => typeof v === 'string' && DB_NAME.test(v);
/** Canonical unsigned decimal string 0..2^63-1 (no sign, no leading zero, no exponent). */
export function isDec64(v: unknown): v is string {
  return typeof v === 'string' && DEC.test(v) && BigInt(v) <= DEC64_MAX;
}
export const isPositiveDec64 = (v: unknown): v is string => isDec64(v) && BigInt(v) > 0n;
export const dec = (v: string): bigint => BigInt(v);
/** UTC instant with exactly milliseconds and Z, and a real calendar value. */
export function isTime(v: unknown): v is string {
  if (typeof v !== 'string' || !TIME.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString() === v;
}
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export const isMonth = (v: unknown): v is string => isDay(v) && (v as string).endsWith('-01');
/** An absolute POSIX path without empty, '.' or '..' components or trailing slash (realpath identity is checked separately). */
export function isAbsPath(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 2 || v.length > 1024 || !v.startsWith('/') || v.endsWith('/') || v.includes('\0')) return false;
  return v.slice(1).split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
export const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
export const isBool = (v: unknown): v is boolean => v === true || v === false;
export const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A plain JSON object (from parseStrictJson) with EXACTLY these own keys; returns it typed as a record. */
export function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) shapeFail();
  const own = Object.keys(v as object);
  if (own.length !== keys.length || !keys.every(k => Object.prototype.hasOwnProperty.call(v, k))) shapeFail();
  return v as Record<string, unknown>;
}
export function req<T>(ok: (x: unknown) => x is T, v: unknown): T { if (!ok(v)) shapeFail(); return v as T; }
/** Every string (keys included) in a parsed value is well-formed UTF-16 (no lone surrogates from \\u escapes). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const wellFormedString = (s: string): boolean => !LONE_SURROGATE.test(s);
export function wellFormed(v: unknown): boolean {
  if (typeof v === 'string') return wellFormedString(v);
  if (Array.isArray(v)) return v.every(wellFormed);
  if (typeof v === 'object' && v !== null) return Object.entries(v).every(([k, x]) => wellFormedString(k) && wellFormed(x));
  return true;
}
/** UTC day of an instant string (truncation, never rounding: ms precision already). */
export const utcDay = (time: string): string => time.slice(0, 10);
export const utcMonthOf = (day: string): string => `${day.slice(0, 7)}-01`;
