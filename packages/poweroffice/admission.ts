import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ExportSession } from '../../connectors/poweroffice/contract.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { CLAIM_WINDOW_MS, READ_WINDOW_MS, RETAINED_ATTEMPT_LIMIT, powerOfficeError } from './contracts.ts';
import type { PowerOfficeErrorCode } from './contracts.ts';
import { withPowerOfficeAuthority } from './authority.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { checkBinding, readConnection } from './binding.ts';
import type { Binding } from './binding.ts';
import { initializeState, lockAttempt, lockState } from './locks.ts';
import type { PowerOfficeKey, StateRow } from './locks.ts';
import { businessDate, parseUtcInstant } from './calendar.ts';
import { compositionPort } from './composition.ts';
import { factAuditId, mintClaim } from './capabilities.ts';
import type { ClaimIdentity, FailureContinuation, SyncClaim } from './capabilities.ts';
import { insertAudit, insertClaim, retainedAttempts } from './rows.ts';

/**
 * Sync admission (docs/stage4/04_PORT_AND_SYNC.md "Manual synchronization" step 1, 03 "Protected reads and lock order").
 * The composition is checked first (DISABLED / MODE_UNSUPPORTED before any database or source work). Then ONE authority
 * transaction (authority.ts): bearer → fence FOR UPDATE → readiness → current all-of sync rights on one membership →
 * client scope + plain Connection read; the lock step refuses an invalid/unbound/non-FIXTURE binding BEFORE anything is
 * written, and only then initializes the State (INSERT … ON CONFLICT DO NOTHING under the fence) and locks it FOR UPDATE,
 * then the existing ACTIVE attempt FOR UPDATE if one is named. The conservative monotonic anchor is taken at the end of
 * the lock step — before the authority's final DB clock read and before the startedAt read — so pool/lock waits consume
 * the original window and the local deadlines are never later than the stored ones. After ALL locks and fresh re-auth:
 * an existing ACTIVE claim is POWEROFFICE_SYNC_BUSY even when expired (explicit recovery first); 1000 retained attempts
 * are POWEROFFICE_SYNC_LIMIT; both before any source call and without writes. Otherwise identities are allocated once and
 * the ACTIVE attempt (DB startedAt, +60 s read, +80 s total), the State sequence/pointer/lastAttempt and the STARTED audit
 * commit together. Admission is never retried; a known conflict is the fixed POWEROFFICE_DB_CONFLICT with zero effects.
 */
export interface Admitted { readonly claim: SyncClaim; readonly failure: FailureContinuation; readonly attemptId: string; readonly sequence: number }
interface Locked { binding: Binding | null; refused: PowerOfficeErrorCode | null; state: StateRow | null; anchor: number }

export async function admitSync(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string, connectionId: string): Promise<Admitted> {
  const port = compositionPort(composition);
  if (typeof clientId !== 'string' || typeof connectionId !== 'string') throw powerOfficeError('INVALID_ARGUMENTS');
  const identity = await withPowerOfficeAuthority<Locked, ClaimIdentity>(db, credential, { clientId, connectionId, operation: 'sync' }, {
    async lock(tx, scope) {
      const key: PowerOfficeKey = { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId: scope.connectionId };
      const row = SCOPE_ID_PATTERN.test(connectionId) ? await readConnection(tx, key.workspaceId, key.clientId, key.connectionId) : null;
      const checked = checkBinding(row, 'source');
      if ('refused' in checked) return { binding: null, refused: checked.refused, state: null, anchor: performance.now() };
      await initializeState(tx, key);
      const state = await lockState(tx, key, 'UPDATE');
      if (state?.activeAttemptId) await lockAttempt(tx, key, state.activeAttemptId);
      return { binding: checked.binding, refused: null, state, anchor: performance.now() };
    },
    async run(tx, authority, locked) {
      if (locked.refused !== null || locked.binding === null || locked.state === null) return { refused: locked.refused ?? 'POWEROFFICE_CONNECTION_UNAVAILABLE' };
      const again = checkBinding(authority.connection, 'source');
      if ('refused' in again) return { refused: again.refused };
      if (again.binding.companyKey !== locked.binding.companyKey || again.binding.lifecycleVersion !== locked.binding.lifecycleVersion) {
        return { refused: 'POWEROFFICE_BINDING_CHANGED' };
      }
      const key: PowerOfficeKey = { workspaceId: authority.workspaceId, clientId: authority.clientId, connectionId: authority.connectionId };
      if (locked.state.activeAttemptId !== null) return { refused: 'POWEROFFICE_SYNC_BUSY' };
      if (await retainedAttempts(tx, key) >= RETAINED_ATTEMPT_LIMIT) return { refused: 'POWEROFFICE_SYNC_LIMIT' };
      const attemptId = randomUUID(); const claimToken = randomUUID(); const allocatedSnapshotId = randomUUID();
      const sequence = locked.state.nextSequence;
      const { asOf } = await insertClaim(tx, key, { attemptId, sequence, claimToken, allocatedSnapshotId, lifecycleVersion: locked.binding.lifecycleVersion,
        actorId: authority.actorId, correlationId: authority.correlationId });
      await insertAudit(tx, key, { id: factAuditId(claimToken, 'poweroffice.sync.started', attemptId), actorId: authority.actorId,
        correlationId: authority.correlationId, eventType: 'poweroffice.sync.started' },
        { connectionId: key.connectionId, attemptId, sequence: String(sequence), outcome: 'STARTED' });
      const instant = parseUtcInstant(asOf);
      if (instant === null) throw powerOfficeError('UNEXPECTED_ERROR');
      // Millisecond storage may round the DB clock down by < 1 ms: one more millisecond keeps each local deadline earlier.
      return { ok: { ...key, actorId: authority.actorId, correlationId: authority.correlationId, companyKey: locked.binding.companyKey,
        lifecycleVersion: locked.binding.lifecycleVersion, attemptId, claimToken, sequence, allocatedSnapshotId, asOf, businessDate: businessDate(instant),
        readDeadline: locked.anchor + READ_WINDOW_MS - 1, deadline: locked.anchor + CLAIM_WINDOW_MS - 1 } };
    },
  });
  // After the commit, outside any transaction: the private export session pinned to this claim, then the capabilities. A
  // session the port refuses leaves no readable claim (the pass fails as SOURCE_FAILED and the failure continuation closes it).
  let session: ExportSession | null = null;
  try {
    session = port.openSession({ connectionId: identity.connectionId, companyKey: identity.companyKey, lifecycleVersion: identity.lifecycleVersion,
      attemptId: identity.attemptId, asOf: identity.asOf });
  } catch { session = null; }
  const { claim, failure } = mintClaim(identity, credential, port, session);
  return Object.freeze({ claim, failure, attemptId: identity.attemptId, sequence: identity.sequence });
}
