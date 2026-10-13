import type { Prisma, PrismaClient } from '@prisma/client';
import type { PowerOfficeErrorCode } from './contracts.ts';
import { withPowerOfficeAuthority } from './authority.ts';
import type { PowerOfficeScope } from './authority.ts';
import { checkBinding } from './binding.ts';
import type { ConnectionRow } from './binding.ts';
import { lockState } from './locks.ts';
import type { PowerOfficeKey, StateRow } from './locks.ts';
import type { ClaimIdentity, ClaimRecord } from './capabilities.ts';
import { attemptClock, lockAttemptRow } from './rows.ts';
import type { AttemptRow } from './rows.ts';

/**
 * Fresh page admission (docs/stage4/04_PORT_AND_SYNC.md "Built in port": "The first page and EVERY later page require fresh
 * caller/binding authorization before one invocation"). One authority transaction per page — bearer → fence FOR UPDATE →
 * readiness → current all-of sync rights → scope + plain Connection read → State FOR UPDATE → owned Attempt FOR UPDATE →
 * DB clock, token and rights again after ALL locks — that writes nothing and commits BEFORE the port call (no transaction
 * or lock is held over source work). It requires the exact owned ACTIVE claim (POWEROFFICE_CLAIM_STALE otherwise), the
 * unchanged FIXTURE binding of the claim's company and lifecycle version (CONNECTION_UNAVAILABLE / BINDING_CHANGED) and the
 * DB clock before the claim's stored readDeadlineAt (POWEROFFICE_DEADLINE). Revocation right after this commit can leave
 * that one admitted read in flight; it permits no next page or publication. Never retried.
 */
export function claimKey(identity: ClaimIdentity): PowerOfficeKey {
  return { workspaceId: identity.workspaceId, clientId: identity.clientId, connectionId: identity.connectionId };
}
/** The stored attempt is exactly the claim's identity (ID, private token, sequence, allocated snapshot, version, asOf, actor). */
export function sameIdentity(row: AttemptRow | null, identity: ClaimIdentity): row is AttemptRow {
  return row !== null && row.id === identity.attemptId && row.claimToken === identity.claimToken && row.sequence === identity.sequence
    && row.allocatedSnapshotId === identity.allocatedSnapshotId && row.lifecycleVersion === identity.lifecycleVersion
    && row.asOf === identity.asOf && row.actorId === identity.actorId;
}
/** The exact owned claim is still the State's ACTIVE attempt. */
export const ownsActiveClaim = (state: StateRow | null, row: AttemptRow | null, identity: ClaimIdentity): boolean =>
  state !== null && sameIdentity(row, identity) && row.state === 'ACTIVE' && state.activeAttemptId === identity.attemptId;
/** Source work and publication need the unchanged FIXTURE binding of the claim's synthetic company and lifecycle version. */
export function sourceBindingRefusal(connection: ConnectionRow | null, identity: ClaimIdentity): PowerOfficeErrorCode | null {
  const checked = checkBinding(connection, 'source');
  if ('refused' in checked) return checked.refused === 'POWEROFFICE_NOT_FOUND' ? 'POWEROFFICE_CONNECTION_UNAVAILABLE' : checked.refused;
  const b = checked.binding;
  return b.companyKey === identity.companyKey && b.lifecycleVersion === identity.lifecycleVersion ? null : 'POWEROFFICE_BINDING_CHANGED';
}
export interface ClaimLocks { state: StateRow | null; row: AttemptRow | null }
/** Write-order locks of an owned claim: State FOR UPDATE, then the claim's Attempt FOR UPDATE (never initializes State). */
export async function lockClaim(tx: Prisma.TransactionClient, scope: PowerOfficeScope, identity: ClaimIdentity): Promise<ClaimLocks> {
  if (scope.workspaceId !== identity.workspaceId || scope.clientId !== identity.clientId || scope.connectionId !== identity.connectionId) return { state: null, row: null };
  const key = claimKey(identity);
  const state = await lockState(tx, key, 'UPDATE');
  return { state, row: state ? await lockAttemptRow(tx, key, identity.attemptId) : null };
}

/** Authorizes the next page of this claim (separate committed transaction); throws the fixed refusal code otherwise. */
export async function authorizePage(db: PrismaClient, record: ClaimRecord): Promise<void> {
  const identity = record.identity;
  await withPowerOfficeAuthority<ClaimLocks, true>(db, record.credential, { clientId: identity.clientId, connectionId: identity.connectionId, operation: 'sync' }, {
    lock: (tx, scope) => lockClaim(tx, scope, identity),
    async run(tx, authority, locked) {
      if (authority.actorId !== identity.actorId || !ownsActiveClaim(locked.state, locked.row, identity)) return { refused: 'POWEROFFICE_CLAIM_STALE' };
      const binding = sourceBindingRefusal(authority.connection, identity);
      if (binding !== null) return { refused: binding };
      if (!(await attemptClock(tx, claimKey(identity), identity.attemptId)).readOpen) return { refused: 'POWEROFFICE_DEADLINE' };
      return { ok: true };
    },
  });
}
