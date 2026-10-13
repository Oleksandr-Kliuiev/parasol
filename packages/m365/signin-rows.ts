import { createHash } from 'node:crypto';
import type { M365SignInV1 } from '../../connectors/microsoft365/signin-dto.ts';
import { m365Limits } from '../../connectors/microsoft365/contract.ts';

/**
 * Pure rules for sign-in rows of one leaf (docs/stage2/03_CONNECTOR_SYNC.md §1, §5). Graph is asked with the documented
 * inclusive `ge from and le to`; Atlas keeps the half-open [from, to) locally: a row exactly at `to` is validated and
 * discarded (it still counts toward the leaf/attempt/request row limits), any row outside [from, to] invalidates the whole
 * attempt. Comparison uses the full sub-millisecond precision of the source time (up to 7 digits), never an assumed
 * precision. occurredAt is the time truncated to milliseconds (TIMESTAMP(3)); for millisecond-aligned bounds truncation
 * preserves membership in [from, to).
 */
export type WindowPosition = 'IN' | 'UPPER_BOUND' | 'OUTSIDE';

/** Canonical createdDateTime from the parser: YYYY-MM-DDTHH:MM:SS.fff[ffff]Z. */
function instant(createdDateTime: string): { ms: number; subMs: boolean } {
  const ms = Date.parse(`${createdDateTime.slice(0, 23)}Z`);
  return { ms, subMs: /[1-9]/.test(createdDateTime.slice(23, -1)) };
}
export function windowPosition(createdDateTime: string, from: Date, to: Date): WindowPosition {
  const { ms, subMs } = instant(createdDateTime);
  if (!Number.isFinite(ms) || ms < from.getTime()) return 'OUTSIDE';
  if (ms > to.getTime() || (ms === to.getTime() && subMs)) return 'OUTSIDE';
  if (ms === to.getTime()) return 'UPPER_BOUND';
  return 'IN';
}

export interface SignInVersion { sourceId: string; contentHash: string; dto: M365SignInV1; occurredAt: Date; expiresAt: Date; userId: string | null; deviceId: string | null }
/**
 * Immutable evidence version (dtoVersion m365-signin-v1): the content hash covers the canonical allowlisted DTO with a
 * fixed key order, so equal content deduplicates and any changed allowlisted value is a new version.
 */
export function signInVersion(dto: M365SignInV1): SignInVersion {
  const canonical = { appId: dto.appId, createdDateTime: dto.createdDateTime, deviceId: dto.deviceId, errorCode: dto.errorCode, id: dto.id,
    isInteractive: dto.isInteractive, userId: dto.userId };
  const contentHash = createHash('sha256').update(`m365-signin-v1\n${JSON.stringify(canonical)}`, 'utf8').digest('hex');
  const occurredAt = new Date(instant(dto.createdDateTime).ms);
  return { sourceId: dto.id, contentHash, dto: canonical, occurredAt, expiresAt: new Date(occurredAt.getTime() + m365Limits.signIns.retentionMs),
    userId: dto.userId, deviceId: dto.deviceId };
}

/**
 * Retry delay of a transient failure: a 429's Retry-After exactly (even beyond the 15-minute backoff cap); a 429 without
 * it 60s plus bounded jitter; otherwise exponential from 30s, capped at 15 minutes (jitter included in the cap).
 */
export function retryDelayMs(code: string, retryAfterSeconds: string | undefined, attemptsUsed: number, jitter: number = Math.random()): number {
  const b = m365Limits.backoff;
  const spread = Math.floor(Math.max(0, Math.min(1, jitter)) * b.jitterMs);
  if (code === 'M365_RATE_LIMITED') return retryAfterSeconds !== undefined ? Number(retryAfterSeconds) * 1000 : b.rateLimitFallbackMs + spread;
  return Math.min(b.maxMs, b.baseMs * 2 ** Math.max(0, attemptsUsed - 1) + spread);
}

/** Two nonoverlapping halves, each at least the minimum leaf duration, or null when the leaf cannot be split. */
export function splitBounds(from: Date, to: Date): [[Date, Date], [Date, Date]] | null {
  const span = to.getTime() - from.getTime();
  if (span < 2 * m365Limits.signIns.minLeafMs) return null;
  const mid = new Date(from.getTime() + Math.floor(span / 2));
  return [[from, mid], [mid, to]];
}
