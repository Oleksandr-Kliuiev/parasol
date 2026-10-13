import { randomUUID } from 'node:crypto';
import type { FailureCode } from './codes.ts';
import { buildResponse } from './envelope.ts';
import { encodeFrame, FrameError, METADATA_FRAME_CAP } from './frame.ts';
import { CensusRelationError, decodeSnapshot, decodeWrapper, pricingMatches } from './payloads.ts';
import type { Snapshot, SnapshotWrapper } from './payloads.ts';
import { sqlStateOf } from './physical.ts';
import type { QueryClient } from './physical.ts';
import type { PhysicalTuple } from './private-frames.ts';
import { RevalShapeError } from './scalars.ts';

/**
 * The controller's evidence reader (brief §7 "Reader"): ONE fixed transaction — REPEATABLE READ READ ONLY, deadline-derived
 * local timeouts, the argument-free snapshot routine, COMMIT — within the operation's monotonic budget. No other SQL besides
 * the fixed physical query. Every failure is a fixed code; a truncated or partial census is never a success.
 */
export class ReaderFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.name = 'ReaderFailure'; this.code = code; }
}
export function readerCodeFor(sqlState: string | undefined): FailureCode {
  switch (sqlState) {
    case 'RV001': return 'REGISTRATION_MISMATCH';
    case 'RV002': case 'RV006': case '57014': case '55P03': return 'CENSUS_UNAVAILABLE';
    case 'RV003': return 'CENSUS_LIMIT_EXCEEDED';
    case 'RV004': return 'POLICY_CHANGED';
    case 'RV005': return 'FIXTURE_MISMATCH';
    default: return 'INTERNAL_FAILURE';
  }
}
export { sqlStateOf };
/** Runs the fixed snapshot transaction; rejects with ReaderFailure. `deadline` is absolute on `now()` (monotonic ms). */
export async function readSnapshotWrapper(client: QueryClient, deadline: number, now: () => number): Promise<SnapshotWrapper> {
  const remaining = Math.floor(deadline - now());
  if (remaining < 150) throw new ReaderFailure('CENSUS_UNAVAILABLE');
  const statementMs = remaining - 100; const lockMs = Math.min(1000, remaining - 200);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReaderFailure('CENSUS_UNAVAILABLE')), remaining); });
  const run = async () => {
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${statementMs}`);
      await client.query(`SET LOCAL lock_timeout = ${lockMs}`);
      const rows = (await client.query('SELECT public.atlas_reval_snapshot() AS w')).rows;
      await client.query('COMMIT');
      if (rows.length !== 1) throw new ReaderFailure('INTERNAL_FAILURE');
      return decodeWrapper(rows[0]!.w);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ReaderFailure) throw error;
      if (error instanceof RevalShapeError) throw new ReaderFailure('INTERNAL_FAILURE');
      throw new ReaderFailure(sqlStateOf(error) === undefined ? 'CENSUS_UNAVAILABLE' : readerCodeFor(sqlStateOf(error)));
    }
  };
  try { return await Promise.race([run(), wall]); } finally { clearTimeout(timer); }
}
/** Registration/instance/physical/build binding of a wrapper to the owner config and C's own build digest. */
export function wrapperBound(w: SnapshotWrapper, expected: { registrationId: string; databaseInstanceId: string; physical: PhysicalTuple; buildManifestSha256: string }): boolean {
  return w.registrationId === expected.registrationId && w.databaseInstanceId === expected.databaseInstanceId
    && w.systemIdentifier === expected.physical.systemIdentifier && w.databaseOid === expected.physical.databaseOid
    && w.postmasterStartTime === expected.physical.postmasterStartTime && w.buildManifestSha256 === expected.buildManifestSha256;
}
/**
 * The exported SNAPSHOT: exact 02 keys with a fresh random snapshotId, after binding and approved-pricing checks.
 * POLICY_CHANGED for any pricing mismatch; CENSUS_UNAVAILABLE for a broken relationship of a consistent snapshot.
 */
export function exportSnapshot(w: SnapshotWrapper, approvedPriceRevision: string): Snapshot {
  if (!pricingMatches(w, approvedPriceRevision)) throw new ReaderFailure('POLICY_CHANGED');
  let s: Snapshot;
  try { s = decodeSnapshot({ snapshotId: randomUUID(), ...w.snapshot }); }
  catch (error) {
    if (error instanceof CensusRelationError) throw new ReaderFailure('CENSUS_UNAVAILABLE');
    if (error instanceof RevalShapeError) throw new ReaderFailure('INTERNAL_FAILURE');
    throw error;
  }
  if (!snapshotFitsEnvelope(w)) throw new ReaderFailure('CENSUS_LIMIT_EXCEEDED');
  return s;
}
/**
 * The byte cap (brief §7: envelope > 256 KiB → CENSUS_LIMIT_EXCEEDED, never truncated), decided at reader level and the
 * SAME for SNAPSHOT and the PAUSE_EXPORT reread: the would-be 06 SNAPSHOT response with every variable-length envelope
 * field at its maximum (Dec64 sequences of 19 digits) must encode within the 256 KiB frame cap. Deterministic in the census.
 */
const MAX_DEC64 = '9223372036854775807';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
export function snapshotFitsEnvelope(w: SnapshotWrapper): boolean {
  const worst = buildResponse({ registrationId: PLACEHOLDER, serverBootId: PLACEHOLDER, connectionId: PLACEHOLDER },
    { challenge: PLACEHOLDER, sequence: MAX_DEC64 }, MAX_DEC64, 'CONTROLLER', PLACEHOLDER, 'SNAPSHOT', { snapshotId: PLACEHOLDER, ...w.snapshot },
    '2026-01-01T00:00:00.000Z');
  try { encodeFrame(worst, METADATA_FRAME_CAP); return true; }
  catch (error) { if (error instanceof FrameError) return false; throw error; }
}
