import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { PrismaSecurityAudit } from '../audit/prisma.ts';

/**
 * Workspace security denial at the public M365 sync boundaries (review RC2-R4; docs/stage2/02_CONTRACTS.md §1:
 * unauthorized client → workspace SecurityAuditEvent, never a write into a client the actor may have lost).
 * A refused permission or scope — before the claim, during I/O, before publication or while recording a failure — ends the
 * operation and appends exactly one workspace denial per boundary invocation through the actor-bound PrismaSecurityAudit,
 * in its own workspace-scope transaction, independent of any rolled-back client transaction. The row holds the actor's
 * workspace, the requested client ID as text, a fixed event type, the safe code and a correlation ID; metadata is empty
 * (no connection or vendor ID, secret, DTO or upstream text). A failed audit write is not swallowed: the caller receives
 * SECURITY_AUDIT_FAILED instead of a denial that looks recorded.
 */
export const isDenial = (error: unknown): error is AtlasError =>
  error instanceof AtlasError && (error.code === 'PERMISSION_DENIED' || error.code === 'SCOPE_DENIED');

export async function appendDenial(db: PrismaClient, actor: Actor, requestedClientId: string, eventType: string, reasonCode: string): Promise<void> {
  try {
    await new PrismaSecurityAudit(db, actor).append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType, outcome: 'DENIED',
      requestedClientId, reasonCode, correlationId: randomUUID(), metadata: {} });
  } catch {
    throw new AtlasError('SECURITY_AUDIT_FAILED', 'PERMANENT', { reasonCode });
  }
}

/** Runs one public operation; a denial anywhere inside it is audited once at this boundary and rethrown. */
export async function withDenialAudit<T>(db: PrismaClient, actor: Actor, scope: Scope, eventType: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (isDenial(error)) await appendDenial(db, actor, String(scope.clientId), eventType, error.code);
    throw error;
  }
}

/**
 * Failure recording after an operation error. A denial — of the original error or of the recording transaction itself —
 * is rethrown (the boundary audits it once); any other recording error leaves the outcome honestly unrecorded.
 */
export async function recordUnlessDenied<T>(origin: unknown, record: () => Promise<T>, unrecorded: T): Promise<T> {
  let recorded: T;
  try { recorded = await record(); }
  catch (recordError) {
    if (isDenial(origin)) throw origin;
    if (isDenial(recordError)) throw recordError;
    return unrecorded;
  }
  if (isDenial(origin)) throw origin;
  return recorded;
}
