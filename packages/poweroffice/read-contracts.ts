import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { UUID_PATTERN, isPowerOfficeErrorCode, powerOfficeError } from './contracts.ts';
import type { InvoiceSummary, PowerOfficeErrorCode } from './contracts.ts';
import { validateSummary } from './aggregate.ts';
import { isGregorianDate, parseUtcInstant } from './calendar.ts';

/**
 * S4-C dedicated read DTOs (docs/stage4/02_CONTRACTS.md "Public interface", 04 "Read view"). Pure: no database, clock or
 * environment. The status precedence is the FIRST matching row of 04's table, evaluated over facts the read service took
 * after all locks with the DB clock (expiry/staleness are computed in SQL, never from the process clock):
 *   1. binding invalid/unavailable, or the current snapshot's lifecycle differs → UNAVAILABLE / that code / null;
 *   2. a prior success whose snapshot is absent (purged) or expired → EXPIRED / SNAPSHOT_EXPIRED / null (outranks failures);
 *   3. no prior success/snapshot, last completed FAILED/ABANDONED → ERROR / retained code / null (even with a new ACTIVE);
 *   4. no prior success/snapshot, nothing completed → MISSING / null / null;
 *   5. unexpired snapshot, last completed FAILED/ABANDONED → STALE / retained code / summary (even with a new ACTIVE);
 *   6. unexpired snapshot older than 15 minutes → STALE / SNAPSHOT_STALE / summary;
 *   7. otherwise FRESH / null / summary.
 * asOf/expiresAt/businessDate accompany a visible snapshot only. The summary DTO has EXACTLY 02's eleven fields; the status
 * DTO omits summary/amounts and may add the local last-attempt ID/sequence and lastSuccessAt. Both are rebuilt field by
 * field and validated against an exact whitelist before leaving the service; every DTO carries synthetic:true. No company
 * key, binding, token, secret reference, nonce, cursor, export/invoice ID or raw text is ever part of either.
 */
export const READ_STATUSES = ['MISSING', 'FRESH', 'STALE', 'ERROR', 'UNAVAILABLE', 'EXPIRED'] as const;
export type ReadStatus = typeof READ_STATUSES[number];
export const LAST_ATTEMPT_STATES = ['NEVER_SYNCED', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'ABANDONED'] as const;
export type LastAttemptState = typeof LAST_ATTEMPT_STATES[number];
export type CompletedState = 'SUCCEEDED' | 'FAILED' | 'ABANDONED';

export interface PowerOfficeSummaryDto {
  readonly connectionId: string; readonly status: ReadStatus; readonly asOf: string | null; readonly expiresAt: string | null;
  readonly businessDate: string | null; readonly summary: InvoiceSummary | null; readonly lastAttemptState: LastAttemptState;
  readonly lastCompletedState: CompletedState | null; readonly lastCompletedErrorCode: PowerOfficeErrorCode | null;
  readonly safeErrorCode: PowerOfficeErrorCode | null; readonly synthetic: true;
}
export interface PowerOfficeStatusDto {
  readonly connectionId: string; readonly status: ReadStatus; readonly asOf: string | null; readonly expiresAt: string | null;
  readonly businessDate: string | null; readonly lastAttemptState: LastAttemptState; readonly lastAttemptId: string | null;
  readonly lastAttemptSequence: number | null; readonly lastCompletedState: CompletedState | null;
  readonly lastCompletedErrorCode: PowerOfficeErrorCode | null; readonly lastSuccessAt: string | null;
  readonly safeErrorCode: PowerOfficeErrorCode | null; readonly synthetic: true;
}
export const SUMMARY_DTO_KEYS = ['connectionId', 'status', 'asOf', 'expiresAt', 'businessDate', 'summary', 'lastAttemptState', 'lastCompletedState',
  'lastCompletedErrorCode', 'safeErrorCode', 'synthetic'] as const;
export const STATUS_DTO_KEYS = ['connectionId', 'status', 'asOf', 'expiresAt', 'businessDate', 'lastAttemptState', 'lastAttemptId', 'lastAttemptSequence',
  'lastCompletedState', 'lastCompletedErrorCode', 'lastSuccessAt', 'safeErrorCode', 'synthetic'] as const;

/** What the read service observed after all locks. `snapshot` is the current pointer's row (null: no pointer or not present). */
export interface ReadFacts {
  readonly binding: 'VALID' | 'POWEROFFICE_CONNECTION_UNAVAILABLE' | 'POWEROFFICE_BINDING_CHANGED';
  readonly priorSuccess: boolean;
  readonly lastCompletedState: string | null;
  readonly lastCompletedErrorCode: string | null;
  readonly snapshot: { readonly expired: boolean; readonly stale: boolean } | null;
}
export interface ReadDecision { readonly status: ReadStatus; readonly safeErrorCode: PowerOfficeErrorCode | null; readonly visible: boolean }

const failed = (state: string | null) => state === 'FAILED' || state === 'ABANDONED';
const retained = (code: string | null): PowerOfficeErrorCode => {
  if (!isPowerOfficeErrorCode(code)) throw powerOfficeError('UNEXPECTED_ERROR');
  return code;
};
/** 04's first-match precedence. `visible` = the snapshot's summary (and its dates) may be returned. */
export function decideRead(facts: ReadFacts): ReadDecision {
  if (facts.binding !== 'VALID') return { status: 'UNAVAILABLE', safeErrorCode: facts.binding, visible: false };
  if ((facts.priorSuccess && facts.snapshot === null) || facts.snapshot?.expired === true) {
    return { status: 'EXPIRED', safeErrorCode: 'POWEROFFICE_SNAPSHOT_EXPIRED', visible: false };
  }
  if (facts.snapshot === null) {
    return failed(facts.lastCompletedState) ? { status: 'ERROR', safeErrorCode: retained(facts.lastCompletedErrorCode), visible: false }
      : { status: 'MISSING', safeErrorCode: null, visible: false };
  }
  if (failed(facts.lastCompletedState)) return { status: 'STALE', safeErrorCode: retained(facts.lastCompletedErrorCode), visible: true };
  if (facts.snapshot.stale) return { status: 'STALE', safeErrorCode: 'POWEROFFICE_SNAPSHOT_STALE', visible: true };
  return { status: 'FRESH', safeErrorCode: null, visible: true };
}

const SEQUENCE = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
const nullable = (v: unknown, check: (x: unknown) => boolean) => v === null || check(v);
const isInstant = (v: unknown) => parseUtcInstant(v) !== null;
const oneOf = (values: readonly string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
const isCode = (v: unknown) => isPowerOfficeErrorCode(v);

/** A stored aggregate re-validated on the way out; a malformed one is never returned (UNEXPECTED_ERROR, no partial data). */
function storedSummary(raw: unknown): InvoiceSummary {
  try { return validateSummary(raw); } catch { throw powerOfficeError('UNEXPECTED_ERROR'); }
}
function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw powerOfficeError('UNEXPECTED_ERROR');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) throw powerOfficeError('UNEXPECTED_ERROR');
  return value as Record<string, unknown>;
}
/** Shared field checks; any mismatch is a programming error and returns nothing (UNEXPECTED_ERROR, never partial data). */
function checkCommon(r: Record<string, unknown>): void {
  const visible = r.status === 'FRESH' || r.status === 'STALE';
  const ok = typeof r.connectionId === 'string' && SCOPE_ID_PATTERN.test(r.connectionId) && oneOf(READ_STATUSES)(r.status)
    && nullable(r.asOf, isInstant) && nullable(r.expiresAt, isInstant) && nullable(r.businessDate, isGregorianDate)
    && (visible ? r.asOf !== null && r.expiresAt !== null && r.businessDate !== null : r.asOf === null && r.expiresAt === null && r.businessDate === null)
    && oneOf(LAST_ATTEMPT_STATES)(r.lastAttemptState) && nullable(r.lastCompletedState, oneOf(['SUCCEEDED', 'FAILED', 'ABANDONED']))
    && nullable(r.lastCompletedErrorCode, isCode) && nullable(r.safeErrorCode, isCode) && r.synthetic === true;
  if (!ok) throw powerOfficeError('UNEXPECTED_ERROR');
}
export function assertSummaryDto(value: unknown): PowerOfficeSummaryDto {
  const r = exactKeys(value, SUMMARY_DTO_KEYS);
  checkCommon(r);
  const visible = r.status === 'FRESH' || r.status === 'STALE';
  if (visible ? r.summary === null : r.summary !== null) throw powerOfficeError('UNEXPECTED_ERROR');
  if (r.summary !== null) storedSummary(r.summary);
  return value as PowerOfficeSummaryDto;
}
export function assertStatusDto(value: unknown): PowerOfficeStatusDto {
  const r = exactKeys(value, STATUS_DTO_KEYS);
  checkCommon(r);
  const ok = nullable(r.lastAttemptId, v => typeof v === 'string' && UUID_PATTERN.test(v)) && nullable(r.lastAttemptSequence, SEQUENCE)
    && (r.lastAttemptId === null) === (r.lastAttemptSequence === null) && (r.lastAttemptId === null) === (r.lastAttemptState === 'NEVER_SYNCED')
    && nullable(r.lastSuccessAt, isInstant);
  if (!ok) throw powerOfficeError('UNEXPECTED_ERROR');
  return value as PowerOfficeStatusDto;
}

/** Observed rows (all values from the service's own SQL) → the exact frozen DTOs. */
export interface ReadView {
  readonly connectionId: string; readonly decision: ReadDecision;
  readonly snapshot: { readonly asOf: string; readonly expiresAt: string; readonly businessDate: string; readonly summary: unknown } | null;
  readonly lastAttemptState: string | null; readonly lastAttemptId: string | null; readonly lastAttemptSequence: number | null;
  readonly lastCompletedState: string | null; readonly lastCompletedErrorCode: string | null; readonly lastSuccessAt: string | null;
}
function common(view: ReadView) {
  const shown = view.decision.visible ? view.snapshot : null;
  if (view.decision.visible && shown === null) throw powerOfficeError('UNEXPECTED_ERROR');
  return {
    connectionId: view.connectionId, status: view.decision.status, asOf: shown?.asOf ?? null, expiresAt: shown?.expiresAt ?? null,
    businessDate: shown?.businessDate ?? null, shown,
    lastAttemptState: (view.lastAttemptState ?? 'NEVER_SYNCED') as LastAttemptState,
    lastCompletedState: view.lastCompletedState as CompletedState | null, lastCompletedErrorCode: view.lastCompletedErrorCode as PowerOfficeErrorCode | null,
  };
}
export function summaryDto(view: ReadView): PowerOfficeSummaryDto {
  const c = common(view);
  return Object.freeze(assertSummaryDto({ connectionId: c.connectionId, status: c.status, asOf: c.asOf, expiresAt: c.expiresAt, businessDate: c.businessDate,
    summary: c.shown === null ? null : storedSummary(c.shown.summary), lastAttemptState: c.lastAttemptState, lastCompletedState: c.lastCompletedState,
    lastCompletedErrorCode: c.lastCompletedErrorCode, safeErrorCode: view.decision.safeErrorCode, synthetic: true }));
}
export function statusDto(view: ReadView): PowerOfficeStatusDto {
  const c = common(view);
  return Object.freeze(assertStatusDto({ connectionId: c.connectionId, status: c.status, asOf: c.asOf, expiresAt: c.expiresAt, businessDate: c.businessDate,
    lastAttemptState: c.lastAttemptState, lastAttemptId: view.lastAttemptId, lastAttemptSequence: view.lastAttemptSequence,
    lastCompletedState: c.lastCompletedState, lastCompletedErrorCode: c.lastCompletedErrorCode, lastSuccessAt: view.lastSuccessAt,
    safeErrorCode: view.decision.safeErrorCode, synthetic: true }));
}
