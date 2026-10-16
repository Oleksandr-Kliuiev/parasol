import { Prisma } from '@prisma/client';
import { requiredUtcTime } from '../../connectors/microsoft365/dto-common.ts';

/**
 * One fixed-width UTC time key for every Stage 2 read predicate (brief RC3 "Coverage, projection and pagination"):
 * `YYYY-MM-DDTHH:mm:ss.fffffffZ`, exactly 28 characters, seven fractional digits. Within years 1000–9999 lexical order of
 * keys is chronological order, so half-open filtering, matching/counting, occurredAt order and the cursor position all use
 * the same comparison. A key is derived by padding the validated canonical text with zeros, never by truncating it:
 * sign-in times keep their source precision (up to 7 digits, DTO canonical form ≥3 digits), millisecond database
 * timestamps get `0000`, and the PostgreSQL clock (microseconds) one `0`. Variable-width fractions are never compared.
 */
export type TimeKey = string;
export const TIME_KEY_LENGTH = 28;
const KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
/** Strict request input: UTC with `Z`, 0..7 fractional digits; the calendar check is the DTO parser's. */
export const UTC_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
/** Canonical sign-in DTO time as stored (3..7 digits); the SQL guard of the read queries uses the same rule. */
export const DTO_TIME_SQL_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3,7}Z$';

export const isTimeKey = (value: unknown): value is TimeKey => typeof value === 'string' && KEY.test(value);
/** The key of a canonical DTO time (3..7 fractional digits). */
export function keyOfCanonical(canonical: string): TimeKey {
  const key = `${canonical.slice(0, -1).padEnd(TIME_KEY_LENGTH - 1, '0')}Z`;
  if (!isTimeKey(key)) throw new RangeError('not a canonical UTC time');
  return key;
}
/** Strict input → key, or null when the text is not a real UTC instant with 0..7 fractional digits. */
export function parseTimeInput(value: unknown): TimeKey | null {
  if (typeof value !== 'string' || !UTC_INPUT_PATTERN.test(value)) return null;
  try { return keyOfCanonical(requiredUtcTime(value, 'input')); } catch { return null; }
}
/** Millisecond Date (database TIMESTAMP(3) or JS clock) → key. */
export const keyOfDate = (date: Date): TimeKey => `${date.toISOString().slice(0, 23)}0000Z`;
/** The millisecond the key falls in (floor), as epoch milliseconds. */
export const floorMs = (key: TimeKey): number => Date.parse(`${key.slice(0, 23)}Z`);
/** Key plus a whole number of milliseconds; the sub-millisecond digits are kept. */
export const keyPlusMs = (key: TimeKey, ms: number): TimeKey => `${new Date(floorMs(key) + ms).toISOString().slice(0, 23)}${key.slice(23, 27)}Z`;
/** Whether the key has sub-millisecond digits (sync creation keeps S2-B millisecond bounds and refuses them). */
export const hasSubMs = (key: TimeKey): boolean => key.slice(23, 27) !== '0000';
/** Epoch ms of the UTC hour the key falls in. */
export const hourFloorMs = (key: TimeKey): number => Math.floor(floorMs(key) / 3_600_000) * 3_600_000;
export const maxKey = (a: TimeKey, b: TimeKey): TimeKey => (a > b ? a : b);
export const minKey = (a: TimeKey, b: TimeKey): TimeKey => (a < b ? a : b);
/** Text a TIMESTAMP(3) column compares with exactly: `::timestamp` ignores the zone suffix by definition. */
export const msText = (ms: number): string => new Date(ms).toISOString();

/**
 * SQL of the key of a stored sign-in DTO time — the same padding as keyOfCanonical. Callers guard it with
 * DTO_TIME_SQL_PATTERN first, so a malformed stored value is excluded instead of producing an error or a wrong order.
 */
export const sqlDtoKey = (alias: string): Prisma.Sql => Prisma.raw(`(rpad(left(${alias}.dto->>'createdDateTime', -1), 27, '0') || 'Z')`);
export const sqlDtoGuard = (alias: string): Prisma.Sql => Prisma.raw(`((${alias}.dto->>'createdDateTime') ~ '${DTO_TIME_SQL_PATTERN}')`);
/** The database clock as one row: the millisecond Date (UTC, floor) and the seven-digit key (microseconds + '0'). */
// date_trunc floors (a cast to timestamp(3) would round up and expire a row half a millisecond early).
export const DB_CLOCK_SQL = Prisma.sql`SELECT date_trunc('milliseconds', now() AT TIME ZONE 'UTC') AS "nowMs",
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '0Z' AS "nowKey"`;
export interface DbClock { readonly now: Date; readonly key: TimeKey }
