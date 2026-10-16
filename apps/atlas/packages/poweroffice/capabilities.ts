import { createHmac } from 'node:crypto';
import type { ExportSession, PowerOfficeExportPort } from '../../connectors/poweroffice/contract.ts';
import { powerOfficeError } from './contracts.ts';
import type { InvoiceSummary } from './contracts.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { validateSummary } from './aggregate.ts';

/**
 * Private S4-B capabilities (docs/stage4/04_PORT_AND_SYNC.md, 03 "Protected reads and lock order"). Admission mints, after
 * its commit, three opaque frozen objects whose state lives only in module-private WeakMaps — a fabricated, copied or
 * serialized object is unknown:
 *   - the export SESSION (the port's own registry), pinned to connection/company/lifecycleVersion/attempt/asOf;
 *   - the sync CLAIM: the caller's private credential (re-authorized before every page and the publication), the exact
 *     stored identity (attempt, claim token, sequence, allocated snapshot, lifecycle version, startedAt = asOf), the
 *     Europe/Oslo business date and the ORIGINAL local deadlines — monotonic instants anchored BEFORE the admission's final
 *     DB clock read, so they are never later than the stored readDeadlineAt (+60 s) / deadlineAt (+80 s); never renewed;
 *   - the FAILURE continuation: the same identity WITHOUT any credential; it can only close its own still-ACTIVE claim
 *     before the original deadline (failure.ts). No read, source or publication authority.
 * Phases: READING (page admissions allowed) → COMPLETE (a complete validated export; publication allowed) → ENDED.
 * The phase alone never proves which aggregate was exported: completing the pass BINDS the claim's one completed fact
 * (a detached frozen re-validated copy and its canonical form) in a separate module-private WeakMap, exactly once.
 * Publication reads only that bound fact; the binding is dropped when the claim ends.
 */
export interface ClaimIdentity {
  readonly workspaceId: string; readonly clientId: string; readonly connectionId: string; readonly actorId: string; readonly correlationId: string;
  readonly companyKey: string; readonly lifecycleVersion: number; readonly attemptId: string; readonly claimToken: string; readonly sequence: number;
  readonly allocatedSnapshotId: string; readonly asOf: string; readonly businessDate: string;
  /** performance.now() instants: the original read window and claim deadline, each ≤ its stored DB counterpart. */
  readonly readDeadline: number; readonly deadline: number;
}
export type ClaimPhase = 'READING' | 'COMPLETE' | 'ENDED';
export interface ClaimRecord {
  readonly identity: ClaimIdentity; readonly credential: PowerOfficeCredential; readonly port: PowerOfficeExportPort;
  session: ExportSession | null; phase: ClaimPhase;
}
export interface SyncClaim { readonly kind: 'PowerOfficeSyncClaim' }
export interface FailureContinuation { readonly kind: 'PowerOfficeFailureContinuation' }

/** The claim's completed export fact: the exact aggregate publication may persist, and its canonical JSON form. */
export interface CompletedFact { readonly summary: InvoiceSummary; readonly canonical: string }

const claims = new WeakMap<SyncClaim, ClaimRecord>();
const failures = new WeakMap<FailureContinuation, ClaimIdentity>();
const facts = new WeakMap<SyncClaim, CompletedFact>();

/** Mints the claim and its failure continuation for one committed admission (admission.ts only). */
export function mintClaim(identity: ClaimIdentity, credential: PowerOfficeCredential, port: PowerOfficeExportPort,
  session: ExportSession | null): { claim: SyncClaim; failure: FailureContinuation } {
  const frozen = Object.freeze({ ...identity });
  const claim: SyncClaim = Object.freeze({ kind: 'PowerOfficeSyncClaim' as const });
  const failure: FailureContinuation = Object.freeze({ kind: 'PowerOfficeFailureContinuation' as const });
  claims.set(claim, { identity: frozen, credential, port, session, phase: 'READING' });
  failures.set(failure, frozen);
  return { claim, failure };
}
/** The record of a genuine claim; a fabricated one refuses with the fixed stale-claim code. */
export function claimRecord(claim: unknown): ClaimRecord {
  const record = typeof claim === 'object' && claim !== null ? claims.get(claim as SyncClaim) : undefined;
  if (record === undefined) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  return record;
}
export function failureIdentity(failure: unknown): ClaimIdentity {
  const identity = typeof failure === 'object' && failure !== null ? failures.get(failure as FailureContinuation) : undefined;
  if (identity === undefined) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  return identity;
}
/** Ends the claim's session for good (idempotent): the port forgets it and no later page can be read. */
export function closeClaimSession(record: ClaimRecord): void {
  const session = record.session;
  record.session = null;
  if (session !== null) record.port.closeSession(session);
}
/**
 * pass.ts only, when the export pass completes: binds the claim's completed fact (a detached frozen re-validated copy of
 * the accumulator's aggregate) and moves READING → COMPLETE. A claim binds at most one fact, only while READING.
 */
export function bindCompletedFact(claim: SyncClaim, summary: InvoiceSummary): void {
  const record = claimRecord(claim);
  if (record.phase !== 'READING' || facts.has(claim)) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  const detached = validateSummary(summary);
  facts.set(claim, Object.freeze({ summary: detached, canonical: JSON.stringify(detached) }));
  record.phase = 'COMPLETE';
}
/** The bound completed fact of a COMPLETE claim; anything else (no complete pass, ended, fabricated) is CLAIM_STALE. */
export function completedFact(claim: SyncClaim): CompletedFact {
  const fact = facts.get(claim);
  if (fact === undefined || claimRecord(claim).phase !== 'COMPLETE') throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  return fact;
}
/** Ends the claim for good: no later page or publication through it; its bound fact is released. */
export function endClaim(claim: SyncClaim): void {
  const record = claims.get(claim);
  if (!record) return;
  closeClaimSession(record);
  facts.delete(claim);
  record.phase = 'ENDED';
}

/**
 * Stable audit-row ID of one claim fact: HMAC-SHA256 keyed by the private claim token (never leaves the DB and the trusted
 * process) over the event and attempt, in UUIDv8 layout. The same fact always gets the same ID, so a lost acknowledgement
 * or a known-rollback re-run can never add a second row; the ID reveals neither the token nor any financial data.
 */
export function factAuditId(claimToken: string, event: string, attemptId: string): string {
  const bytes = createHmac('sha256', claimToken).update(`poweroffice-fact/1\u0000${event}\u0000${attemptId}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
