import type { PrismaClient } from '@prisma/client';
import { powerOfficeError } from './contracts.ts';
import type { InvoiceSummary } from './contracts.ts';
import { isKnownRollback, withPowerOfficeAuthority } from './authority.ts';
import { validateSummary } from './aggregate.ts';
import { claimRecord, completedFact, factAuditId } from './capabilities.ts';
import type { ClaimRecord, SyncClaim } from './capabilities.ts';
import { claimKey, lockClaim, sameIdentity, sourceBindingRefusal } from './page.ts';
import type { ClaimLocks } from './page.ts';
import { attemptClock, closeClaim, insertAudit, insertSnapshot, readSnapshotFact } from './rows.ts';

/**
 * Atomic publication (docs/stage4/03_DATA_AND_CONCURRENCY.md "Protected reads and lock order", 04 step 3,
 * IMPLEMENTATION_HANDOFF.md items 4 and 6). Only a COMPLETE claim publishes, with the claim's allocated identities and the
 * SAME detached fact its own export pass bound to it (RC1 R1: a different valid aggregate is refused before any effect).
 * One authority transaction: fence FOR UPDATE → plain Connection → State FOR UPDATE →
 * owned Attempt FOR UPDATE → fresh token/actor/all-of sync rights and the DB clock after ALL locks; the unchanged FIXTURE
 * binding of the claim's company and lifecycle version. Then:
 *   - the attempt already SUCCEEDED with exactly this fact (attempt, version, asOf, business date, aggregate): a no-op
 *     receipt — also after the original deadline (lost acknowledgement), never a payload, never a second audit row;
 *     the same identity with a different fact is POWEROFFICE_PUBLICATION_CONFLICT;
 *   - otherwise the claim must be the State's ACTIVE attempt (else POWEROFFICE_CLAIM_STALE: recovered, failed or late) and
 *     the DB clock before its stored deadlineAt (else POWEROFFICE_DEADLINE; the guards also re-check at the statement and
 *     at COMMIT); snapshot + pointer + SUCCEEDED + lastAttempt/lastCompleted + lastSuccessAt + the audit row (stable ID
 *     keyed by the private claim token) commit together, or nothing does.
 * Only a POSITIVELY KNOWN rollback (40P01/40001, authority.ts isKnownRollback) re-runs the whole transaction — fresh
 * authority, binding and DB clock each time, the same immutable fact and IDs, zero port calls — at most three times in
 * total; exhaustion is POWEROFFICE_PUBLICATION_CONFLICT and leaves the claim ACTIVE for explicit recovery. Every other
 * failure (audit, generic conflict, transaction timeout, unknown commit outcome) is returned as its fixed code at once:
 * never a new export, never a claimed success, never an automatic failure.
 */
export const PUBLICATION_ATTEMPTS = 3;
export interface PowerOfficeSyncReceipt {
  readonly connectionId: string; readonly attemptId: string; readonly sequence: number; readonly snapshotId: string;
  readonly state: 'SUCCEEDED'; readonly idempotent: boolean; readonly synthetic: true;
}

async function publishOnce(db: PrismaClient, record: ClaimRecord, summary: InvoiceSummary, canonical: string): Promise<PowerOfficeSyncReceipt> {
  const id = record.identity;
  const key = claimKey(id);
  const receipt = (idempotent: boolean): PowerOfficeSyncReceipt => Object.freeze({ connectionId: id.connectionId, attemptId: id.attemptId,
    sequence: id.sequence, snapshotId: id.allocatedSnapshotId, state: 'SUCCEEDED' as const, idempotent, synthetic: true as const });
  return withPowerOfficeAuthority<ClaimLocks, PowerOfficeSyncReceipt>(db, record.credential, { clientId: id.clientId, connectionId: id.connectionId, operation: 'sync' }, {
    lock: (tx, scope) => lockClaim(tx, scope, id),
    async run(tx, authority, locked) {
      const row = locked.row;
      if (authority.actorId !== id.actorId || locked.state === null || !sameIdentity(row, id)) return { refused: 'POWEROFFICE_CLAIM_STALE' };
      const binding = sourceBindingRefusal(authority.connection, id);
      if (binding !== null) return { refused: binding };
      if (row.state === 'SUCCEEDED') {
        const stored = await readSnapshotFact(tx, key, id.allocatedSnapshotId);
        if (stored === null) return { refused: 'POWEROFFICE_CLAIM_STALE' };
        let same = false;
        try {
          same = stored.attemptId === id.attemptId && stored.lifecycleVersion === id.lifecycleVersion && stored.asOf === id.asOf
            && stored.businessDate === id.businessDate && JSON.stringify(validateSummary(stored.summary)) === canonical;
        } catch { same = false; }
        return same ? { ok: receipt(true) } : { refused: 'POWEROFFICE_PUBLICATION_CONFLICT' };
      }
      if (row.state !== 'ACTIVE' || locked.state.activeAttemptId !== id.attemptId) return { refused: 'POWEROFFICE_CLAIM_STALE' };
      const clock = await attemptClock(tx, key, id.attemptId);
      if (!clock.open) return { refused: 'POWEROFFICE_DEADLINE' };
      await insertSnapshot(tx, key, id.attemptId, id.businessDate, summary, clock.at);
      await closeClaim(tx, key, id.attemptId, 'SUCCEEDED', null, clock.at, { id: id.allocatedSnapshotId, lifecycleVersion: id.lifecycleVersion });
      await insertAudit(tx, key, { id: factAuditId(id.claimToken, 'poweroffice.sync.succeeded', id.attemptId), actorId: id.actorId,
        correlationId: id.correlationId, eventType: 'poweroffice.sync.succeeded' },
        { connectionId: id.connectionId, attemptId: id.attemptId, snapshotId: id.allocatedSnapshotId, sequence: String(id.sequence), outcome: 'SUCCEEDED' });
      return { ok: receipt(false) };
    },
  });
}

/**
 * Publishes the completed fact BOUND to a COMPLETE claim (capabilities.ts), also as an explicit identical replay; see the
 * module comment. The supplied `fact` is only the caller's statement of what it publishes: it must be structurally
 * identical to the bound fact, otherwise POWEROFFICE_PUBLICATION_CONFLICT before any authority transaction or effect —
 * whether the claim is still ACTIVE, its earlier publication rolled back, or it already SUCCEEDED. What is persisted and
 * compared with a stored snapshot is always the bound fact itself, never the caller's object.
 */
export async function publishFact(db: PrismaClient, claim: SyncClaim, fact: unknown): Promise<PowerOfficeSyncReceipt> {
  const record = claimRecord(claim);
  const bound = completedFact(claim);
  if (JSON.stringify(validateSummary(fact)) !== bound.canonical) throw powerOfficeError('POWEROFFICE_PUBLICATION_CONFLICT');
  for (let attempt = 1; ; attempt++) {
    try { return await publishOnce(db, record, bound.summary, bound.canonical); }
    catch (error) {
      if (!isKnownRollback(error)) throw error;
      if (attempt >= PUBLICATION_ATTEMPTS) throw powerOfficeError('POWEROFFICE_PUBLICATION_CONFLICT');
    }
  }
}
