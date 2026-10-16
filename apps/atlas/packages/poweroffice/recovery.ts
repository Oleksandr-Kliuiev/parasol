import type { PrismaClient } from '@prisma/client';
import { powerOfficeError } from './contracts.ts';
import { withPowerOfficeAuthority } from './authority.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { checkBinding } from './binding.ts';
import { lockState } from './locks.ts';
import type { PowerOfficeKey, StateRow } from './locks.ts';
import { compositionPort } from './composition.ts';
import { factAuditId } from './capabilities.ts';
import { attemptClock, closeClaim, insertAudit, lockAttemptRow } from './rows.ts';
import type { AttemptRow } from './rows.ts';

/**
 * Explicit recovery (docs/stage4/04_PORT_AND_SYNC.md step 5, 03 "Protected reads and lock order"). Fresh authority with
 * the current all-of sync rights (operation recover) after ALL locks; no port, no source I/O, no State initialization.
 * Locks: fence FOR UPDATE → plain Connection → existing State FOR UPDATE → its ACTIVE Attempt FOR UPDATE. The connection
 * may now be DISABLED or at an advanced lifecycle version in the same immutable synthetic binding (no reactivation, no
 * data): only the binding's synthetic shape is required (closeout). No State or no ACTIVE attempt — including after a
 * committed publication whose acknowledgement was lost — is POWEROFFICE_NO_ACTIVE_ATTEMPT with zero audit/domain effects;
 * DB clock before the claim's stored deadlineAt (startedAt + 80 s) is POWEROFFICE_RECOVERY_NOT_DUE with zero effects. At or
 * after it the claim becomes ABANDONED (POWEROFFICE_DEADLINE), the active pointer clears, lastAttempt/lastCompleted take
 * the outcome and the ABANDONED audit row commits atomically; the snapshot pointer and lastSuccessAt are untouched. A late
 * result of the old claim can no longer publish (publication.ts: CLAIM_STALE); a later sync is a new attempt. Never retried.
 */
export interface PowerOfficeRecoveryReceipt {
  readonly connectionId: string; readonly attemptId: string; readonly sequence: number; readonly state: 'ABANDONED';
  readonly safeErrorCode: 'POWEROFFICE_DEADLINE'; readonly synthetic: true;
}
interface Locked { state: StateRow | null; row: AttemptRow | null }

export async function recoverPowerOffice(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string,
  connectionId: string): Promise<PowerOfficeRecoveryReceipt> {
  compositionPort(composition); // mode first; the port itself is never used by recovery
  if (typeof clientId !== 'string' || typeof connectionId !== 'string') throw powerOfficeError('INVALID_ARGUMENTS');
  return withPowerOfficeAuthority<Locked, PowerOfficeRecoveryReceipt>(db, credential, { clientId, connectionId, operation: 'recover' }, {
    async lock(tx, scope) {
      const key: PowerOfficeKey = { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId: scope.connectionId };
      const state = await lockState(tx, key, 'UPDATE');
      return { state, row: state?.activeAttemptId ? await lockAttemptRow(tx, key, state.activeAttemptId) : null };
    },
    async run(tx, authority, { state, row }) {
      const binding = checkBinding(authority.connection, 'closeout');
      if ('refused' in binding) return { refused: binding.refused };
      if (state === null || state.activeAttemptId === null) return { refused: 'POWEROFFICE_NO_ACTIVE_ATTEMPT' };
      if (row === null || row.state !== 'ACTIVE' || row.id !== state.activeAttemptId) return { refused: 'POWEROFFICE_DB_CONFLICT' };
      const key: PowerOfficeKey = { workspaceId: authority.workspaceId, clientId: authority.clientId, connectionId: authority.connectionId };
      const clock = await attemptClock(tx, key, row.id);
      if (clock.open) return { refused: 'POWEROFFICE_RECOVERY_NOT_DUE' };
      await closeClaim(tx, key, row.id, 'ABANDONED', 'POWEROFFICE_DEADLINE', clock.at);
      await insertAudit(tx, key, { id: factAuditId(row.claimToken, 'poweroffice.sync.abandoned', row.id), actorId: authority.actorId,
        correlationId: authority.correlationId, eventType: 'poweroffice.sync.abandoned' },
        { connectionId: key.connectionId, attemptId: row.id, sequence: String(row.sequence), outcome: 'ABANDONED', safeErrorCode: 'POWEROFFICE_DEADLINE' });
      return { ok: Object.freeze({ connectionId: key.connectionId, attemptId: row.id, sequence: row.sequence, state: 'ABANDONED' as const,
        safeErrorCode: 'POWEROFFICE_DEADLINE' as const, synthetic: true as const }) };
    },
  });
}
