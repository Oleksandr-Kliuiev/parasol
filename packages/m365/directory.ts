import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, ErrorKind, Scope } from '../core/contracts.ts';
import { AtlasError, errorDetails, errorKind, safeErrorCode } from '../core/contracts.ts';
import { directoryUrl, m365Limits } from '../../connectors/microsoft365/contract.ts';
import { parseM365DevicePage, parseM365UserPage } from '../../connectors/microsoft365/directory-dto.ts';
import type { M365DeviceV1, M365UserV1 } from '../../connectors/microsoft365/directory-dto.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { assertM365Permissions, lockAndCheck, lockForRecording, pinOf } from './authority.ts';
import type { M365Pin } from './authority.ts';
import { openSession, plusMs, systemClock } from './io.ts';
import { recordUnlessDenied, withDenialAudit } from './denial.ts';
import { retryDelayMs } from './signin-rows.ts';
import type { Clock, M365Io } from './io.ts';

/**
 * Directory full generations (docs/stage2/03_CONNECTOR_SYNC.md §4, 02 §3). One job per connection × resource:
 *  claim    — one transaction BEFORE any I/O (atomic admission, review RC2-R2): Connection FOR SHARE + current authority;
 *             the state row is created if absent (ON CONFLICT DO NOTHING waits for a concurrent first insert), then locked
 *             FOR UPDATE and the clock read; an exhausted budget (M365_ATTEMPTS_EXHAUSTED) or a future retryAt
 *             (M365_RETRY_NOT_DUE) refuses without any write. Only then the sequence and the budget advance by one, and — in
 *             a later statement — a STAGING generation with attemptSeq, claimToken, 12m lease and the pinned lifecycleVersion.
 *  stage    — each validated page in its own short transaction under the generation (FOR SHARE); duplicate IDs across pages
 *             are accepted only when identical, contradictory ones fail the job. Staged rows are never read as published.
 *  publish  — ONE transaction: Connection FOR SHARE (ACTIVE at the pinned version, authority current) → state FOR UPDATE
 *             (still the newest started sequence) → generation FOR UPDATE (own unexpired claim), clock read after the
 *             locks; then typed ExternalEntity mirrors (opaque ID + attribute codes, observedAt advanced only here), the
 *             PUBLISHED generation, pointer/counts/lastSuccess and the audit row. The SQL fence/deferred triggers enforce it.
 *  fail     — own generation → FAILED; the resource state records the failure only for the newest started, unexpired claim,
 *             keeping the last good pointer (STALE on read). Never a deletion inferred from a partial read. Every TRANSIENT
 *             failure persists retryAt — also on the final attempt: a 429 the exact Retry-After (even above the 15m cap;
 *             60s + jitter without one), others exponential from 30s by charged attempts, capped at 15m.
 *  budget   — at most 8 charged claims (crashed and superseded ones included) since the latest publication, which resets it
 *             with retryAt; afterwards only an explicit audited reset (directory-retry.ts) starts a new chain.
 * Public boundary syncM365Directory audits a permission/scope denial once in the workspace security audit (denial.ts).
 * Deadlines and leases are read from the database rows, never from the caller-held claim descriptor.
 * No lock is held over the network: Graph I/O happens between these transactions only.
 */
export type DirectoryResource = 'm365_user' | 'm365_device';
const ENDPOINT = { m365_user: 'users', m365_device: 'devices' } as const;
type DirectoryDto = M365UserV1 | M365DeviceV1;

export interface DirectoryClaim {
  readonly pin: M365Pin; readonly resourceType: DirectoryResource; readonly generationId: string; readonly attemptSeq: number;
  readonly claimToken: string; readonly startedAt: Date;
  /** Charged claims of this chain including this one (informational; the database row is authoritative). */
  readonly attemptsUsed: number;
}
export interface DirectorySyncResult {
  resourceType: DirectoryResource; status: 'PUBLISHED' | 'FAILED'; attemptSeq: number; generationId: string; rowCount: number | null;
  /** FAILED only: whether this failure became the resource's recorded state (false for a superseded or expired claim). */
  recorded: boolean; safeErrorCode: string | null; errorKind: ErrorKind | null; retryAfterSeconds: string | null;
  /** Persisted throttle: no attempt of this resource starts before it (any recorded TRANSIENT failure). */
  retryAt: Date | null;
  /** Charged claims of the chain (this one included) and the budget; a publication then resets the persisted count to 0. */
  attemptsUsed: number; maxAttempts: number;
}
const MAX_ATTEMPTS = m365Limits.directory.maxAttempts;
const keyOf = (claim: DirectoryClaim) => ({ workspaceId: claim.pin.workspaceId, clientId: claim.pin.clientId, connectionId: claim.pin.connectionId,
  resourceType: claim.resourceType });

export async function claimDirectoryGeneration(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, resourceType: DirectoryResource,
  clock: Clock = systemClock): Promise<DirectoryClaim> {
  assertM365Permissions(actor, scope, 'sync', connectionId);
  if (resourceType !== 'm365_user' && resourceType !== 'm365_device') throw new AtlasError('M365_RESOURCE_UNSUPPORTED', 'VALIDATION');
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockAndCheck(tx, actor, scope, connectionId, 'sync');
    await tx.$executeRaw`INSERT INTO "M365ResourceState" ("workspaceId", "clientId", "connectionId", "resourceType")
      VALUES (${scope.workspaceId}, ${scope.clientId}, ${connectionId}, ${resourceType})
      ON CONFLICT ("workspaceId", "clientId", "connectionId", "resourceType") DO NOTHING`;
    const [admission] = await tx.$queryRaw<{ retryAt: Date | null; attemptsUsed: number }[]>`SELECT "retryAt", "attemptsUsed" FROM "M365ResourceState"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType}
      FOR UPDATE`;
    const now = clock(); // after the Connection and state locks
    const used = Number(admission!.attemptsUsed);
    const budget = { attemptsUsed: String(used), maxAttempts: String(MAX_ATTEMPTS), ...(admission!.retryAt ? { retryAt: admission!.retryAt.toISOString() } : {}) };
    if (used >= MAX_ATTEMPTS) throw new AtlasError('M365_ATTEMPTS_EXHAUSTED', 'PERMANENT', budget);
    if (admission!.retryAt && admission!.retryAt.getTime() > now.getTime()) {
      throw new AtlasError('M365_RETRY_NOT_DUE', 'TRANSIENT', { ...budget, retryAfterSeconds: String(Math.ceil((admission!.retryAt.getTime() - now.getTime()) / 1000)) });
    }
    const [state] = await tx.$queryRaw<{ seq: number; used: number }[]>`UPDATE "M365ResourceState" SET "latestStartedSeq" = "latestStartedSeq" + 1,
      "attemptsUsed" = "attemptsUsed" + 1, "lastAttemptAt" = GREATEST("lastAttemptAt", ${now})
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType}
      RETURNING "latestStartedSeq" AS seq, "attemptsUsed" AS used`;
    const attemptSeq = Number(state!.seq);
    const claim: DirectoryClaim = Object.freeze({ pin: pinOf(scope, connectionId, row, 'sync'), resourceType, generationId: randomUUID(), attemptSeq,
      claimToken: randomUUID(), startedAt: now, attemptsUsed: Number(state!.used) });
    await tx.m365DirectoryGeneration.create({ data: { ...keyOf(claim), id: claim.generationId, attemptSeq, lifecycleVersion: row.lifecycleVersion,
      claimToken: claim.claimToken, leaseExpiresAt: plusMs(now, m365Limits.directory.leaseMs), startedAt: now,
      expiresAt: plusMs(now, m365Limits.directory.retentionMs) }, select: { id: true } });
    return claim;
  });
}

/** The claim is still current: own STAGING generation, unexpired lease, newest started sequence. Read-only (no locks). */
export async function assertDirectoryClaim(tx: Prisma.TransactionClient, claim: DirectoryClaim, now: Date): Promise<void> {
  const key = keyOf(claim);
  const [g] = await tx.$queryRaw<{ state: string; claimToken: string | null; leaseExpiresAt: Date | null; startedAt: Date; started: number }[]>`
    SELECT g.state, g."claimToken"::text AS "claimToken", g."leaseExpiresAt", g."startedAt", s."latestStartedSeq" AS started FROM "M365DirectoryGeneration" g
    JOIN "M365ResourceState" s USING ("workspaceId", "clientId", "connectionId", "resourceType")
    WHERE g."workspaceId" = ${key.workspaceId} AND g."clientId" = ${key.clientId} AND g."connectionId" = ${key.connectionId}
      AND g."resourceType" = ${key.resourceType} AND g.id = ${claim.generationId}`;
  if (!g || g.state !== 'STAGING' || g.claimToken !== claim.claimToken) throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
  if (!g.leaseExpiresAt || now.getTime() >= g.leaseExpiresAt.getTime()) throw new AtlasError('M365_CLAIM_EXPIRED', 'PERMANENT');
  if (Number(g.started) !== claim.attemptSeq) throw new AtlasError('M365_ATTEMPT_SUPERSEDED', 'PERMANENT');
  // Hard job deadline from the persisted start, not from the caller-held descriptor
  if (now.getTime() > g.startedAt.getTime() + m365Limits.directory.jobDeadlineMs) throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'jobDeadline' });
}

const canonical = (dto: DirectoryDto) => JSON.stringify(Object.keys(dto).sort().map(k => [k, (dto as unknown as Record<string, unknown>)[k]]));

/** Stages one validated page; returns the number of objects new to this generation. */
export async function stageDirectoryPage(db: PrismaClient, actor: Actor, claim: DirectoryClaim, items: readonly DirectoryDto[], clock: Clock = systemClock): Promise<number> {
  if (items.length === 0) return 0;
  const key = keyOf(claim);
  return withScope(db, actor, [key.clientId], async tx => {
    await tx.$queryRaw`SELECT id FROM "M365DirectoryGeneration" WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId}
      AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType} AND id = ${claim.generationId} FOR SHARE`;
    await assertDirectoryClaim(tx, claim, clock());
    const existing = await tx.m365DirectoryObject.findMany({ where: { ...key, generationId: claim.generationId, sourceObjectId: { in: items.map(i => i.id) } },
      select: { sourceObjectId: true, dto: true } });
    const known = new Map(existing.map(o => [o.sourceObjectId, canonical(o.dto as unknown as DirectoryDto)]));
    for (const item of items) {
      const before = known.get(item.id);
      if (before !== undefined && before !== canonical(item)) throw new AtlasError('M365_DUPLICATE_CONFLICT', 'PERMANENT');
    }
    const fresh = items.filter(i => !known.has(i.id));
    if (fresh.length > 0) {
      await tx.m365DirectoryObject.createMany({ data: fresh.map(i => ({ ...key, generationId: claim.generationId, sourceObjectId: i.id,
        deviceId: claim.resourceType === 'm365_device' ? (i as M365DeviceV1).deviceId : null, dto: i as unknown as Prisma.InputJsonValue })) });
    }
    return fresh.length;
  });
}

export interface PublishHooks { beforeCommit?(tx: Prisma.TransactionClient): Promise<void> }

/** The single publication transaction; any check that fails rolls everything back and leaves the old pointer. */
export async function publishDirectoryGeneration(db: PrismaClient, actor: Actor, claim: DirectoryClaim, clock: Clock = systemClock,
  hooks: PublishHooks = {}): Promise<{ rowCount: number }> {
  const key = keyOf(claim);
  return withScope(db, actor, [key.clientId], async tx => {
    await lockAndCheck(tx, actor, claim.pin);
    await tx.$queryRaw`SELECT 1 FROM "M365ResourceState" WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId}
      AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM "M365DirectoryGeneration" WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId}
      AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType} AND id = ${claim.generationId} FOR UPDATE`;
    const now = clock(); // every lock held
    await assertDirectoryClaim(tx, claim, now);
    const rowCount = await tx.m365DirectoryObject.count({ where: { ...key, generationId: claim.generationId } });
    if (rowCount > m365Limits.directory.maxRows) throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'rows' });
    // Typed mirrors: opaque ID and attribute codes only; existing ExternalEntity rows (and their links) are reused.
    await tx.$executeRaw`INSERT INTO "ExternalEntity" ("workspaceId", "clientId", id, "connectionId", "resourceType", "externalId", attributes, "observedAt")
      SELECT o."workspaceId", o."clientId", gen_random_uuid()::text, o."connectionId", o."resourceType", o."sourceObjectId",
        jsonb_strip_nulls(jsonb_build_object(
          'userType', CASE WHEN o."resourceType" = 'm365_user' THEN o.dto->>'userType' END,
          'accountEnabled', CASE o.dto->'accountEnabled' WHEN 'true'::jsonb THEN 'TRUE' WHEN 'false'::jsonb THEN 'FALSE' END)), ${now}
      FROM "M365DirectoryObject" o
      WHERE o."workspaceId" = ${key.workspaceId} AND o."clientId" = ${key.clientId} AND o."connectionId" = ${key.connectionId}
        AND o."resourceType" = ${key.resourceType} AND o."generationId" = ${claim.generationId}
      ON CONFLICT ("workspaceId", "clientId", "connectionId", "resourceType", "externalId") DO UPDATE SET attributes = EXCLUDED.attributes,
        "observedAt" = GREATEST("ExternalEntity"."observedAt", EXCLUDED."observedAt")`;
    await tx.$executeRaw`UPDATE "M365DirectoryObject" o SET "externalEntityId" = e.id FROM "ExternalEntity" e
      WHERE o."workspaceId" = ${key.workspaceId} AND o."clientId" = ${key.clientId} AND o."connectionId" = ${key.connectionId}
        AND o."resourceType" = ${key.resourceType} AND o."generationId" = ${claim.generationId}
        AND e."workspaceId" = o."workspaceId" AND e."clientId" = o."clientId" AND e."connectionId" = o."connectionId"
        AND e."resourceType" = o."resourceType" AND e."externalId" = o."sourceObjectId"`;
    await tx.m365DirectoryGeneration.update({ where: { workspaceId_clientId_connectionId_resourceType_id: { ...key, id: claim.generationId } },
      data: { state: 'PUBLISHED', completedAt: now, claimToken: null, leaseExpiresAt: null, rowCount, expiresAt: plusMs(now, m365Limits.directory.retentionMs) },
      select: { id: true } });
    await tx.$executeRaw`UPDATE "M365ResourceState" SET "activeGenerationId" = ${claim.generationId}, "latestPublishedSeq" = ${claim.attemptSeq},
      "latestRecordedSeq" = ${claim.attemptSeq}, status = 'OK', "safeErrorCode" = NULL, "retryAt" = NULL, "attemptsUsed" = 0,
      "lastAttemptAt" = GREATEST("lastAttemptAt", ${now}), "lastSuccessAt" = ${now}
      WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType}`;
    await tx.auditEvent.create({ data: clientAuditData(claim.pin, actor.id, 'm365.directory_published', randomUUID(), { connectionId: key.connectionId,
      system: 'microsoft365', resourceType: key.resourceType, attemptSeq: String(claim.attemptSeq), rowCount: String(rowCount) }), select: { id: true } });
    await hooks.beforeCommit?.(tx);
    return { rowCount };
  });
}

/**
 * Records a failed job. The own generation (same claim token) becomes FAILED; the resource state takes the failure only
 * while this is the newest started attempt with an unexpired lease — an older or expired claim never writes on behalf of
 * its successor. The published pointer and lastSuccessAt stay (last good data, STALE on read).
 */
export interface DirectoryFailure { recorded: boolean; retryAt: Date | null; attemptsUsed: number; maxAttempts: number }
export async function recordDirectoryFailure(db: PrismaClient, actor: Actor, claim: DirectoryClaim, failure: unknown, clock: Clock = systemClock,
  jitter: number = Math.random()): Promise<DirectoryFailure> {
  const error = typeof failure === 'string' ? new AtlasError(failure, 'PERMANENT') : failure;
  const code = safeErrorCode(error);
  const key = keyOf(claim);
  return withScope(db, actor, [key.clientId], async tx => {
    await lockForRecording(tx, actor, claim.pin, key.connectionId);
    const [state] = await tx.$queryRaw<{ started: number; used: number }[]>`SELECT "latestStartedSeq" AS started, "attemptsUsed" AS used FROM "M365ResourceState"
      WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType} FOR UPDATE`;
    const [g] = await tx.$queryRaw<{ state: string; claimToken: string | null; leaseExpiresAt: Date | null }[]>`SELECT state, "claimToken"::text AS "claimToken", "leaseExpiresAt"
      FROM "M365DirectoryGeneration" WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId}
        AND "resourceType" = ${key.resourceType} AND id = ${claim.generationId} FOR UPDATE`;
    const now = clock();
    const used = Number(state?.used ?? 0);
    const none: DirectoryFailure = { recorded: false, retryAt: null, attemptsUsed: used, maxAttempts: MAX_ATTEMPTS };
    if (!g || g.state !== 'STAGING' || g.claimToken !== claim.claimToken) return none;
    const current = Number(state?.started) === claim.attemptSeq && g.leaseExpiresAt !== null && now.getTime() < g.leaseExpiresAt.getTime();
    await tx.m365DirectoryGeneration.update({ where: { workspaceId_clientId_connectionId_resourceType_id: { ...key, id: claim.generationId } },
      data: { state: 'FAILED', completedAt: now, claimToken: null, leaseExpiresAt: null, safeErrorCode: code }, select: { id: true } });
    if (!current) return none;
    // §6 (review RC2-R1): every TRANSIENT failure persists its retry time, also on the final attempt — a 429 exactly as asked,
    // others exponential by charged attempts, capped at 15m. A PERMANENT failure clears it (the budget still counts).
    const retryAt = errorKind(error) === 'TRANSIENT' ? plusMs(now, retryDelayMs(code, errorDetails(error).retryAfterSeconds, used, jitter)) : null;
    await tx.$executeRaw`UPDATE "M365ResourceState" SET "latestRecordedSeq" = ${claim.attemptSeq}, status = 'ERROR', "safeErrorCode" = ${code},
      "retryAt" = ${retryAt}, "lastAttemptAt" = GREATEST("lastAttemptAt", ${now})
      WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType}`;
    await tx.auditEvent.create({ data: clientAuditData(claim.pin, actor.id, 'm365.directory_failed', randomUUID(), { connectionId: key.connectionId,
      system: 'microsoft365', resourceType: key.resourceType, attemptSeq: String(claim.attemptSeq), attemptsUsed: String(used), safeErrorCode: code }),
    select: { id: true } });
    return { recorded: true, retryAt, attemptsUsed: used, maxAttempts: MAX_ATTEMPTS };
  });
}

/** Reads every page of the resource, stages it, and publishes only a complete, bounded, consistent traversal. */
export async function traverseAndStage(db: PrismaClient, actor: Actor, claim: DirectoryClaim, io: M365Io, clock: Clock): Promise<void> {
  const endpoint = ENDPOINT[claim.resourceType];
  const parse = claim.resourceType === 'm365_user' ? parseM365UserPage : parseM365DevicePage;
  const session = openSession(db, actor, claim.pin, io, clock, tx => assertDirectoryClaim(tx, claim, clock()));
  const traversal = session.traverse(endpoint, directoryUrl(endpoint));
  const limits = m365Limits.directory;
  let rows = 0;
  for (;;) {
    if (traversal.pages >= limits.maxPages) throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'pages' });
    const page = await traversal.next();
    if (!page) return;
    const { items } = parse(page.body);
    rows += items.length;
    if (rows > limits.maxRows) throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'rows' });
    await stageDirectoryPage(db, actor, claim, items as DirectoryDto[], clock);
    if (page.nextLink === null) return;
  }
}

/**
 * Public directory sync boundary. A permission/scope denial — before the claim, during I/O, before publication or while
 * recording the failure — is audited once in the workspace security audit and rethrown; nothing is written into the client.
 */
export function syncM365Directory(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, resourceType: DirectoryResource,
  io: M365Io, clock: Clock = systemClock): Promise<DirectorySyncResult> {
  return withDenialAudit(db, actor, scope, 'm365.directory_sync_denied', async () => {
    const claim = await claimDirectoryGeneration(db, actor, scope, connectionId, resourceType, clock);
    const base = { resourceType, attemptSeq: claim.attemptSeq, generationId: claim.generationId, maxAttempts: MAX_ATTEMPTS };
    try {
      await traverseAndStage(db, actor, claim, io, clock);
      const { rowCount } = await publishDirectoryGeneration(db, actor, claim, clock);
      return { ...base, status: 'PUBLISHED', rowCount, recorded: true, safeErrorCode: null, errorKind: null, retryAfterSeconds: null, retryAt: null,
        attemptsUsed: claim.attemptsUsed };
    } catch (error) {
      const failure = await recordUnlessDenied<DirectoryFailure>(error, () => recordDirectoryFailure(db, actor, claim, error, clock),
        { recorded: false, retryAt: null, attemptsUsed: claim.attemptsUsed, maxAttempts: MAX_ATTEMPTS });
      return { ...base, status: 'FAILED', rowCount: null, recorded: failure.recorded, safeErrorCode: safeErrorCode(error), errorKind: errorKind(error),
        retryAfterSeconds: errorDetails(error).retryAfterSeconds ?? null, retryAt: failure.retryAt, attemptsUsed: failure.attemptsUsed };
    }
  });
}
