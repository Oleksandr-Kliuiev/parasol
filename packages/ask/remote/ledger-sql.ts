import { ASK_REMOTE_PROFILE, SETTLEMENT_OUTCOMES, parsePolicyVersion, validUsage } from './budget.ts';
import type { PauseReason, SettlementOutcome, Usage } from './budget.ts';

/**
 * ASK-REMOTE R-A finite DB helpers: the fixed statements that call the confined routines of migration 202610111020, their
 * strictly validated positional parameters (BigInt policyVersion as a canonical decimal string, never Number) and the
 * SQLSTATE → fixed code mapping. No connection, transaction or clock here: the later R-B composition runs these inside its
 * own bounded phases (scope settings set first; reserve as the last step of the egress transaction; settle in a separate
 * financial-only transaction; pause in a separate fence-first transaction). Errors never echo values.
 */

export const RESERVE_SQL = `SELECT public.atlas_ask_remote_reserve($1, $2, $3, $4::uuid, $5::bigint, $6::integer, $7, $8, $9::uuid)::text AS "attemptId"`;
export const SETTLE_SQL = `SELECT public.atlas_ask_remote_settle($1, $2, $3::uuid, $4::uuid, $5, $6::integer, $7::integer)::text AS "accountedMicroUsd"`;
export const PAUSE_SQL = `SELECT public.atlas_ask_remote_pause($1, $2::uuid, $3)::text AS "policyVersion"`;
/**
 * R-B (migration 202610121000): the reservation of the egress transaction with the ORIGINAL-deadline floor inside the
 * routine, after every lock wait and before the INSERT/return. $10 is a clock_timestamp() text sample of the SAME
 * transaction, $11 the whole milliseconds above the floor measured by the application after that sample returned.
 */
export const RESERVE_FLOOR_SQL = `SELECT public.atlas_ask_remote_reserve_floor($1, $2, $3, $4::uuid, $5::bigint, $6::integer, $7, $8, $9::uuid, `
  + `$10::timestamptz + $11::integer * interval '1 millisecond')::text AS "attemptId"`;

export type AskRemoteLedgerCode = 'ASK_REMOTE_NOT_ADMITTED' | 'ASK_REMOTE_POLICY_CHANGED' | 'ASK_REMOTE_BUDGET' | 'ASK_REMOTE_SCOPE'
  | 'ASK_REMOTE_AUTHORITY_CHANGED' | 'ASK_REMOTE_SETTLEMENT_REFUSED' | 'ASK_REMOTE_GUARD' | 'ASK_REMOTE_VERSION_EXHAUSTED'
  | 'ASK_REMOTE_REVISION_REFUSED' | 'ASK_REMOTE_LEDGER_INVARIANT';
/** Fixed SQLSTATEs raised by the remote routines, guard and deferred ledger check. */
export const ASK_REMOTE_SQLSTATES: Readonly<Record<string, AskRemoteLedgerCode>> = Object.freeze({
  AR001: 'ASK_REMOTE_NOT_ADMITTED', AR002: 'ASK_REMOTE_POLICY_CHANGED', AR003: 'ASK_REMOTE_BUDGET', AR004: 'ASK_REMOTE_SCOPE',
  AR005: 'ASK_REMOTE_AUTHORITY_CHANGED', AR006: 'ASK_REMOTE_SETTLEMENT_REFUSED', AR007: 'ASK_REMOTE_GUARD', AR008: 'ASK_REMOTE_VERSION_EXHAUSTED',
  AR009: 'ASK_REMOTE_REVISION_REFUSED', AR010: 'ASK_REMOTE_LEDGER_INVARIANT',
});
/** R-B: the original-deadline floor refusal of atlas_ask_remote_reserve_floor (an ASK_DEADLINE, not a ledger outcome). */
export const FLOOR_SQLSTATE = 'AR011';
/** The fixed code of a database error (its `code` property), or null for any other failure (treated as unknown by callers). */
export function ledgerErrorCode(error: unknown): AskRemoteLedgerCode | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && Object.hasOwn(ASK_REMOTE_SQLSTATES, code) ? ASK_REMOTE_SQLSTATES[code]! : null;
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = (): never => { throw new RangeError('ASK_REMOTE_LEDGER_ARGUMENT_INVALID'); };
const id = (v: unknown): string => typeof v === 'string' && SCOPE_ID.test(v) ? v : invalid();
const uuid = (v: unknown): string => typeof v === 'string' && UUID_V4.test(v) ? v : invalid();

export interface ReserveInput {
  workspaceId: string; clientId: string; actorId: string; admissionId: string; policyVersion: string; fenceVersion: number;
  priceRevision: string; correlationId: string;
}
/** Parameters of RESERVE_SQL; the profile is the fixed compiled-in identity, never caller-supplied. */
export function reserveParams(input: ReserveInput): unknown[] {
  if (parsePolicyVersion(input.policyVersion) === null || !Number.isSafeInteger(input.fenceVersion) || input.fenceVersion < 0
    || input.fenceVersion > 2_147_483_647 || typeof input.priceRevision !== 'string' || !REF.test(input.priceRevision)) invalid();
  return [id(input.workspaceId), id(input.clientId), id(input.actorId), uuid(input.admissionId), input.policyVersion, input.fenceVersion,
    ASK_REMOTE_PROFILE, input.priceRevision, uuid(input.correlationId)];
}

/** Parameters of RESERVE_FLOOR_SQL: reserveParams plus the DB-clock sample text and the non-negative whole ms above the floor. */
export function reserveFloorParams(input: ReserveInput, floor: { sample: string; aboveMs: number }): unknown[] {
  if (typeof floor.sample !== 'string' || floor.sample.length === 0 || floor.sample.length > 64 || !Number.isSafeInteger(floor.aboveMs)
    || floor.aboveMs < 0 || floor.aboveMs > 60_000) invalid();
  return [...reserveParams(input), floor.sample, floor.aboveMs];
}

export interface SettleInput {
  workspaceId: string; clientId: string; attemptId: string; correlationId: string; outcome: SettlementOutcome; usage: Usage | null;
}
/** Parameters of SETTLE_SQL: validated usage only with USAGE_VERIFIED; every other outcome carries no token counts. */
export function settleParams(input: SettleInput): unknown[] {
  if (!SETTLEMENT_OUTCOMES.includes(input.outcome)) invalid();
  if (input.outcome === 'USAGE_VERIFIED' ? !validUsage(input.usage) : input.usage !== null) invalid();
  return [id(input.workspaceId), id(input.clientId), uuid(input.attemptId), uuid(input.correlationId), input.outcome,
    input.usage?.promptTokens ?? null, input.usage?.completionTokens ?? null];
}

const PAUSE_REASONS: readonly PauseReason[] = ['MODEL_MISMATCH', 'USAGE_INVALID', 'UPSTREAM_AUTH'];
/** Parameters of PAUSE_SQL (configuration-fault circuit). */
export function pauseParams(input: { workspaceId: string; admissionId: string; reason: PauseReason }): unknown[] {
  if (!PAUSE_REASONS.includes(input.reason)) invalid();
  return [id(input.workspaceId), uuid(input.admissionId), input.reason];
}
