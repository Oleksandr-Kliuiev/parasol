// Fail-closed validators for every value the R-EVAL execution instrument accepts from an operator or a transient V2
// response. Each failure is an ExecError carrying ONE fixed code; no message, input text, value, length or position is
// ever included, so a malicious or sensitive string can never be echoed to a terminal, receipt or log.
import { RESERVE_MICRO } from '../ask-remote-eval/supervisor.ts';
import type { Settlement } from '../ask-remote-eval/supervisor.ts';

export class ExecError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ExecError'; this.code = code; }
}
export const reject = (code: string): never => { throw new ExecError(code); };
/** Fixed code of any thrown value: an ExecError keeps its code, everything else collapses to `fallback`. */
export const codeOf = (error: unknown, fallback = 'INTERNAL_ERROR'): string => error instanceof ExecError ? error.code : fallback;

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CASE_ID = /^RE-(SUM|URG|SRC|ENT|UNS|ADV)-[0-9]{3}$/;
export const FIXTURE_ID = /^FX[0-9]{2}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/** Focus observation IDs of the frozen fixtures (synthetic `syn-obs-*`); anything else is refused, never echoed. */
export const FOCUS_ID = /^syn-obs-[a-z0-9-]{1,40}$/;
const DECIMAL = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9223372036854775807n;
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
/** Maximum size of one pasted transient value (request/response body); larger input is discarded unread. */
export const TRANSIENT_MAX_BYTES = 262_144;
const MAX_VALIDATED_COST = Math.ceil((32768 * 275 + 512 * 825) / 1000);

export const uuid = (v: unknown, code: string): string => typeof v === 'string' && UUID_V4.test(v) ? v : reject(code);
export const caseId = (v: unknown): string => typeof v === 'string' && CASE_ID.test(v) ? v : reject('CASE_ID_INVALID');
/** Canonical positive decimal in the signed 64-bit range (policyVersion / fence epoch): kept as a string, never a Number. */
export function decimal(v: unknown, code: string): string {
  if (typeof v !== 'string' || !DECIMAL.test(v) || BigInt(v) > MAX_BIGINT) reject(code);
  return v as string;
}
/** Non-negative safe integer from canonical decimal text (no sign, exponent, fraction or leading zero). */
export function safeInt(v: unknown, code: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 && v <= max ? v : reject(code);
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(v)) reject(code);
  const n = Number(v);
  return Number.isSafeInteger(n) && n <= max ? n : reject(code);
}
/** Exact UTC instant `YYYY-MM-DDTHH:MM:SS(.mmm)Z` that round-trips (no rollover such as Feb 30). */
export function utcInstant(v: unknown, code: string): number {
  if (typeof v !== 'string' || !UTC_INSTANT.test(v)) reject(code);
  const ms = Date.parse(v as string);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== (v as string).slice(0, 19)) reject(code);
  return ms;
}
export const focusId = (v: unknown): string | null => v === 'none' ? null : typeof v === 'string' && FOCUS_ID.test(v) ? v : reject('FOCUS_ID_INVALID');
export const httpStatus = (v: unknown): number => {
  const n = safeInt(v, 'HTTP_STATUS_INVALID', 599);
  return n >= 100 ? n : reject('HTTP_STATUS_INVALID');
};

/** Bounded transient text: well-formed, ≤256 KiB UTF-8. The caller keeps it in a local only and drops it after use. */
export function transientText(v: unknown, code: string): string {
  if (typeof v !== 'string' || v.length === 0 || Buffer.byteLength(v, 'utf8') > TRANSIENT_MAX_BYTES) reject(code);
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v as string)) reject(code);
  return v as string;
}

/** Owner admission parameters as entered by the operator (attested, not verified against the server). */
export interface AdmissionInput {
  readonly admissionId: string; readonly startUtc: string; readonly expiryUtc: string; readonly dayCapMicro: string;
  readonly monthCapMicro: string; readonly openingFenceEpoch: string; readonly pacingMax: string;
}
export function admissionValues(a: AdmissionInput): { admissionId: string; startUtcMs: number; expiryUtcMs: number; dayCapMicro: number; monthCapMicro: number;
  openingFenceEpoch: string; pacingMax: number } {
  return { admissionId: uuid(a.admissionId, 'ADMISSION_ID_INVALID'), startUtcMs: utcInstant(a.startUtc, 'ADMISSION_START_INVALID'),
    expiryUtcMs: utcInstant(a.expiryUtc, 'ADMISSION_EXPIRY_INVALID'), dayCapMicro: safeInt(a.dayCapMicro, 'DAY_CAP_INVALID'),
    monthCapMicro: safeInt(a.monthCapMicro, 'MONTH_CAP_INVALID'), openingFenceEpoch: decimal(a.openingFenceEpoch, 'OPENING_FENCE_INVALID'),
    pacingMax: safeInt(a.pacingMax, 'PACING_INVALID', 10) };
}

export interface CountersInput { readonly dayChargedMicro: string; readonly monthChargedMicro: string }
export function counterValues(c: CountersInput, caps: { day: number; month: number }): { dayChargedMicro: number; monthChargedMicro: number } {
  const day = safeInt(c.dayChargedMicro, 'COUNTERS_INVALID'); const month = safeInt(c.monthChargedMicro, 'COUNTERS_INVALID');
  // A UTC day lies inside its month: day ≤ month. Values above the cap cannot come from an enforced ledger.
  if (day > month || day > caps.day || month > caps.month) reject('COUNTERS_INCONSISTENT');
  return { dayChargedMicro: day, monthChargedMicro: month };
}

export const SETTLEMENTS: readonly Settlement[] = ['CONFIRMED', 'RETAINED_KNOWN', 'RETAINED_UNKNOWN_COMMIT', 'NO_DISPATCH', 'NO_RESERVATION'];
/** Numeric ledger metadata of ONE attempt, from an owner read (attested) or the fake ledger (simulated). */
export interface LedgerInput {
  readonly correlationId: string; readonly attempts: string; readonly settlement: string; readonly chargedMicro: string;
  readonly dayChargedMicro: string; readonly monthChargedMicro: string;
}
export interface Ledger {
  readonly correlationId: string; readonly attempts: number; readonly settlement: Settlement; readonly chargedMicro: number;
  readonly dayChargedMicro: number; readonly monthChargedMicro: number;
}
/** Internally consistent ledger metadata or LEDGER_INVALID. attempts ≥2 is returned (a duplicate dispatch) for the caller. */
export function ledgerValues(l: LedgerInput, caps: { day: number; month: number }): Ledger {
  const correlationId = uuid(l.correlationId, 'LEDGER_INVALID');
  const attempts = safeInt(l.attempts, 'LEDGER_INVALID', 200);
  const settlement = (SETTLEMENTS as readonly string[]).includes(l.settlement) ? l.settlement as Settlement : reject('LEDGER_INVALID');
  const charged = safeInt(l.chargedMicro, 'LEDGER_INVALID', RESERVE_MICRO);
  const counters = counterValues({ dayChargedMicro: l.dayChargedMicro, monthChargedMicro: l.monthChargedMicro }, caps);
  const consistent = settlement === 'NO_RESERVATION' ? attempts === 0 && charged === 0
    : attempts >= 1 && (settlement === 'CONFIRMED' ? charged <= MAX_VALIDATED_COST : settlement === 'NO_DISPATCH' ? charged === 0 : charged === RESERVE_MICRO);
  if (!consistent) reject('LEDGER_INVALID');
  return { correlationId, attempts, settlement, chargedMicro: charged, ...counters };
}

/** Owner fence-first closure receipt as entered (attested). Format errors are NOT re-promptable: the supervisor decides. */
export interface ClosureInput { readonly admissionId: string; readonly paused: string; readonly policyVersion: string; readonly fenceEpoch: string }
