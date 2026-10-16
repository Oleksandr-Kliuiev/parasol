import { sanitizeAuditMetadata } from '../audit/sanitize.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { UUID_PATTERN, isPowerOfficeErrorCode } from './contracts.ts';

/**
 * The only client-audit metadata a PowerOffice event may carry (docs/stage4/02_CONTRACTS.md): local connectionId,
 * attemptId, snapshotId, sequence, outcome and safeErrorCode — six keys, each with a fixed shape. No amount, count, source
 * or business date, asOf, company key, export/invoice ID, hash, token or secret reference, ever. The shared allowlist
 * (packages/audit/sanitize.ts) holds other domains' keys too; this factory refuses every key outside the six, so a widened
 * global allowlist can never widen PowerOffice audit.
 *
 * `outcome` is a local operational enum of the JSON metadata, distinct from SecurityAuditEvent.outcome (a column of the
 * workspace denial log). `sequence` is the attempt's operational ordinal, not a financial or deletion count.
 */
export const POWEROFFICE_AUDIT_KEYS = ['connectionId', 'attemptId', 'snapshotId', 'sequence', 'outcome', 'safeErrorCode'] as const;
export type PowerOfficeAuditKey = typeof POWEROFFICE_AUDIT_KEYS[number];
export const POWEROFFICE_AUDIT_OUTCOMES = ['STARTED', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'READ', 'COMPLETED', 'NO_OP'] as const;
export type PowerOfficeAuditOutcome = typeof POWEROFFICE_AUDIT_OUTCOMES[number];
export type PowerOfficeAuditInput = Partial<Record<PowerOfficeAuditKey, string>> & { connectionId: string; outcome: PowerOfficeAuditOutcome };

const OUTCOMES: readonly string[] = POWEROFFICE_AUDIT_OUTCOMES;
const SEQUENCE = /^[1-9][0-9]{0,9}$/;
const valid: Readonly<Record<PowerOfficeAuditKey, (v: string) => boolean>> = {
  connectionId: v => SCOPE_ID_PATTERN.test(v), attemptId: v => UUID_PATTERN.test(v), snapshotId: v => UUID_PATTERN.test(v),
  sequence: v => SEQUENCE.test(v), outcome: v => OUTCOMES.includes(v), safeErrorCode: v => isPowerOfficeErrorCode(v),
};

/** Allowlisted, shape-checked metadata; any other key or malformed value throws (a programming error, never data). */
export function powerOfficeAuditMetadata(input: PowerOfficeAuditInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !(POWEROFFICE_AUDIT_KEYS as readonly string[]).includes(key)) throw new TypeError('PowerOffice audit key not allowed');
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !valid[key as PowerOfficeAuditKey](value)) throw new TypeError('PowerOffice audit value not allowed');
    out[key] = value;
  }
  if (out.connectionId === undefined || out.outcome === undefined) throw new TypeError('PowerOffice audit needs connectionId and outcome');
  const sanitized = sanitizeAuditMetadata(out);
  if (Object.keys(sanitized).length !== Object.keys(out).length) throw new TypeError('PowerOffice audit key missing from the shared allowlist');
  return sanitized;
}
