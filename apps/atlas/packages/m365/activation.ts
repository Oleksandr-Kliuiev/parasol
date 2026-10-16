import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, safeErrorCode } from '../core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { directoryUrl, signInsUrl, m365Limits } from '../../connectors/microsoft365/contract.ts';
import type { M365Endpoint } from '../../connectors/microsoft365/contract.ts';
import type { M365GraphSession } from '../../connectors/microsoft365/connector.ts';
import { parseM365DevicePage, parseM365UserPage } from '../../connectors/microsoft365/directory-dto.ts';
import { parseM365SignInPage } from '../../connectors/microsoft365/signin-dto.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { appendDenial } from './denial.ts';
import { withScope } from '../graph/scoped-db.ts';
import { mapFenceError } from '../graph/fence-errors.ts';
import { assertCurrentAuthority, assertM365Connection, assertM365Permissions, lockAndCheck, pinOf, readM365Connection } from './authority.ts';
import type { M365Pin } from './authority.ts';
import { openSession, plusMs, systemClock } from './io.ts';
import type { Clock, M365Io } from './io.ts';

/**
 * Activation of a bound DISABLED Microsoft 365 connection (docs/stage2/02_CONTRACTS.md §1, 03 §2–3). The generic
 * activateConnection refuses microsoft365; this is the only path to ACTIVE:
 *  1. issue: connections:manage, Connection locked, bound DISABLED (never FIXTURE/ACTIVE), current authority → a capability
 *     pinned to actor, scope, tenant and lifecycleVersion, expiring after 10 minutes. Opaque, in memory only.
 *  2. run (once — a replay is refused before any I/O): token + same-token tenant verification, users and devices
 *     capability probes ($top=1, rows validated then discarded) and a bounded sign-in probe. Nothing is published.
 *     Every secret resolution and vendor call rechecks the pin and the capability expiry; a disable meanwhile fails it.
 *  3. one transaction: Connection locked, still DISABLED at the pinned version, authority current, capability unexpired →
 *     ACTIVE with lifecycleVersion + 1 (conditional UPDATE: a concurrent change consumes nothing), the separately recorded
 *     sign-in capability and the `connection.activated` audit row. Sign-ins 403 → directory-only degraded activation.
 */
export interface M365ActivationCapability { readonly connectionId: string; readonly lifecycleVersion: number; readonly expiresAt: Date }
/** Private state; the expiry is a number fixed at issue — the public Date is a copy for display and is never consulted. */
interface CapabilityState { readonly pin: M365Pin; readonly actorId: string; readonly workspaceId: string; readonly expiresAtMs: number; used: boolean }
const capabilities = new WeakMap<object, CapabilityState>();
export const ACTIVATION_CAPABILITY_TTL_MS = 10 * 60_000;
/** Look-back of the sign-in capability probe; a valid zero-row answer proves access only, never completeness. */
const SIGNIN_PROBE_MS = 60 * 60_000;

export async function issueM365ActivationCapability(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string,
  clock: Clock = systemClock): Promise<M365ActivationCapability> {
  assertM365Permissions(actor, scope, 'activation', connectionId);
  const { pin, now } = await withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockAndCheck(tx, actor, scope, connectionId, 'activation');
    return { pin: pinOf(scope, connectionId, row, 'activation'), now: clock() };
  });
  const expiresAtMs = now.getTime() + ACTIVATION_CAPABILITY_TTL_MS;
  const capability = Object.freeze({ connectionId, lifecycleVersion: pin.lifecycleVersion, expiresAt: new Date(expiresAtMs) });
  capabilities.set(capability, { pin, actorId: actor.id, workspaceId: actor.workspaceId, expiresAtMs, used: false });
  return capability;
}

export type M365ActivationResult =
  | { status: 'ACTIVE'; connectionId: string; lifecycleVersion: number; signIns: 'AVAILABLE' | 'UNAVAILABLE'; safeErrorCode: string | null }
  | { status: 'DISABLED'; connectionId: string; safeErrorCode: string };

async function probe(session: M365GraphSession, endpoint: M365Endpoint, url: string, parse: (body: unknown) => unknown): Promise<void> {
  const page = await session.traverse(endpoint, url).next();
  if (page) parse(page.body); // validated, then discarded
}

export async function runM365Activation(db: PrismaClient, actor: Actor, capability: M365ActivationCapability, io: M365Io,
  clock: Clock = systemClock): Promise<M365ActivationResult> {
  const state = capabilities.get(capability);
  if (!state || state.actorId !== actor.id || state.workspaceId !== actor.workspaceId) throw new AtlasError('ACTIVATION_CAPABILITY_INVALID', 'SCOPE');
  if (state.used) throw new AtlasError('ACTIVATION_CAPABILITY_USED', 'CONFLICT');
  state.used = true; // one use, decided before any I/O
  const { pin } = state;
  const scope: Scope = { workspaceId: pin.workspaceId, clientId: pin.clientId };
  assertM365Permissions(actor, scope, 'activation', pin.connectionId);
  const unexpired = async () => { if (clock().getTime() >= state.expiresAtMs) throw new AtlasError('ACTIVATION_CAPABILITY_EXPIRED', 'PERMANENT'); };
  let signIns: 'AVAILABLE' | 'UNAVAILABLE' = 'AVAILABLE'; let signInCode: string | null = null;
  try {
    await unexpired();
    const session = openSession(db, actor, pin, io, clock, unexpired);
    await session.verifyTenant();
    await probe(session, 'users', directoryUrl('users', 1), parseM365UserPage);
    await probe(session, 'devices', directoryUrl('devices', 1), parseM365DevicePage);
    const now = clock();
    const to = plusMs(now, -m365Limits.signIns.collectionDelayMs);
    try { await probe(session, 'signIns', signInsUrl(plusMs(to, -SIGNIN_PROBE_MS), to, 1), parseM365SignInPage); }
    catch (error) {
      // Access to sign-ins is a separate capability: 403 gives directory-only activation, never an "empty" result.
      if (!(error instanceof AtlasError) || error.code !== 'M365_ACCESS_DENIED') throw error;
      signIns = 'UNAVAILABLE'; signInCode = 'M365_SIGNINS_NOT_AVAILABLE';
    }
    return await commitActivation(db, actor, state, signIns, signInCode, clock);
  } catch (error) {
    const code = safeErrorCode(error);
    await auditFailure(db, actor, scope, pin.connectionId, code);
    return { status: 'DISABLED', connectionId: pin.connectionId, safeErrorCode: code };
  }
}

async function commitActivation(db: PrismaClient, actor: Actor, state: CapabilityState, signIns: 'AVAILABLE' | 'UNAVAILABLE', signInCode: string | null,
  clock: Clock): Promise<M365ActivationResult> {
  const { pin } = state;
  const ids = { workspaceId: pin.workspaceId, clientId: pin.clientId };
  const version = await withScope(db, actor, [pin.clientId], async tx => {
    // Lock first (the row is updated below), then decide with current authority and the clock read after the lock.
    await tx.$queryRaw`SELECT id FROM "Connection" WHERE "workspaceId" = ${ids.workspaceId} AND "clientId" = ${ids.clientId} AND id = ${pin.connectionId} FOR NO KEY UPDATE`;
    const row = await readM365Connection(tx, ids, pin.connectionId, false);
    assertM365Connection(row, 'activation', pin);
    await assertCurrentAuthority(tx, actor, pin.clientId, 'activation');
    const now = clock();
    if (now.getTime() >= state.expiresAtMs) throw new AtlasError('ACTIVATION_CAPABILITY_EXPIRED', 'PERMANENT');
    const consumed = await tx.connection.updateMany({ where: { ...ids, id: pin.connectionId, status: 'DISABLED', lifecycleVersion: pin.lifecycleVersion },
      data: { status: 'ACTIVE', lifecycleVersion: pin.lifecycleVersion + 1 } });
    if (consumed.count !== 1) throw new AtlasError('M365_CONNECTION_CHANGED', 'PERMANENT');
    const ok = signIns === 'AVAILABLE';
    await tx.$executeRaw`INSERT INTO "M365ResourceState" ("workspaceId", "clientId", "connectionId", "resourceType", status, "safeErrorCode", "lastAttemptAt", "lastSuccessAt")
      VALUES (${ids.workspaceId}, ${ids.clientId}, ${pin.connectionId}, 'm365_signin', ${ok ? 'OK' : 'UNAVAILABLE'}, ${signInCode}, ${now}, ${ok ? now : null})
      ON CONFLICT ("workspaceId", "clientId", "connectionId", "resourceType") DO UPDATE SET status = EXCLUDED.status, "safeErrorCode" = EXCLUDED."safeErrorCode",
        "lastAttemptAt" = GREATEST("M365ResourceState"."lastAttemptAt", EXCLUDED."lastAttemptAt"),
        "lastSuccessAt" = CASE WHEN EXCLUDED.status = 'OK' THEN GREATEST("M365ResourceState"."lastSuccessAt", EXCLUDED."lastSuccessAt") ELSE "M365ResourceState"."lastSuccessAt" END`;
    await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, 'connection.activated', randomUUID(), { connectionId: pin.connectionId,
      system: 'microsoft365', connectionStatus: 'ACTIVE', lifecycleVersion: String(pin.lifecycleVersion + 1), ...(signInCode ? { safeErrorCode: signInCode } : {}) }),
    select: { id: true } });
    return pin.lifecycleVersion + 1;
  }).catch(error => { throw mapFenceError(error); }); // Stage 3 authority fence: fixed ACTION_FENCE_NOT_READY, no SQL diagnostics
  m365TokenCache.evictConnection(ids.workspaceId, ids.clientId, pin.connectionId); // probe tokens belong to the old version
  return { status: 'ACTIVE', connectionId: pin.connectionId, lifecycleVersion: version, signIns, safeErrorCode: signInCode };
}

/** Failure audit: a lost authority is a workspace security event (never a write into that client); otherwise client audit. */
export async function auditFailure(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, code: string, eventType = 'connection.activation_failed'): Promise<void> {
  if (code === 'PERMISSION_DENIED' || code === 'SCOPE_DENIED') {
    await appendDenial(db, actor, scope.clientId, `${eventType.split('.')[0]}.m365_denied`, code);
    return;
  }
  await withScope(db, actor, [scope.clientId], tx => tx.auditEvent.create({ data: clientAuditData(scope, actor.id, eventType, randomUUID(),
    { connectionId, system: 'microsoft365', safeErrorCode: code }), select: { id: true } }));
}
