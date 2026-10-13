import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { clientAuditData } from '../audit/prisma.ts';
import type { CorrelationContextV1 } from './contracts.ts';
import { CORRELATION_CONTRACT_VERSION, CORRELATION_RULE_VERSION } from './contracts.ts';
import { assessCoverage, SIGNIN_RETENTION_MS } from './coverage.ts';
import { checkCursor, cursorExpired, cursorExpiry, digestOf, issueCursor, requireCursorKey, transitionAt, verifyCursor } from './cursor.ts';
import type { CursorClaims, CursorKey, CursorKeyProvider, Transition } from './cursor.ts';
import { conflictedSources, correlationItem, loadSignInUsers, userLinkDigest } from './items.ts';
import { parseCorrelationInput } from './parameters.ts';
import type { CorrelationInput, IntervalInput } from './parameters.ts';
import { conflictContributors, contributorFingerprint, contributorTransitions, loadCapability, loadRoots, positionOf, selectionPage, selectionStats } from './query.ts';
import type { ConflictContributor, SelectionSpec } from './query.ts';
import { directoryFingerprint, directoryResource, directoryTransitions, directoryUsability, loadMappings, loadSource, resolve } from './resolve.ts';
import { assertReadable, guardedRead, READ_PERMISSIONS, readSelectedConnection, withReadSnapshot } from './snapshot.ts';
import { keyPlusMs } from './time.ts';
import type { DbClock } from './time.ts';

/**
 * CorrelationContextV1 read (02 §4–5, brief RC3), shared by the HTTP endpoint, the atlas.observation.get_correlation tool
 * and the `correlation` CLI. Every page: authentication-time all-of check → strict input → cursor configuration (fail
 * closed, also for a first page) → MAC verification → ONE RepeatableRead snapshot with current authority and the database
 * clock → expiry, input eligibility, selected connection ACTIVE → resolution, coverage, deduplicated count, conflict
 * contributors → binding/fingerprint comparison → keyset page inside the reloaded eligible selection → allowlisted
 * `correlation.read` client audit (local IDs, counts, codes, version) in the same transaction. Stored data only.
 */
export interface ReadDeps { cursorKey: CursorKeyProvider; correlationId?: string }
export const CORRELATION_DENIED_EVENT = 'correlation.read_denied';

/** Database-clock bounds of the exact interval: no future end, nothing older than the retained seven days. */
export function assertInterval(input: IntervalInput, clock: DbClock): void {
  if (input.to > clock.key) throw new AtlasError('CORRELATION_INTERVAL_FUTURE', 'VALIDATION');
  if (input.from < keyPlusMs(clock.key, -SIGNIN_RETENTION_MS)) throw new AtlasError('CORRELATION_INTERVAL_NOT_RETAINED', 'VALIDATION');
}
/** Input eligibility transition: `from` falls out of the seven-day window strictly AFTER from + 7d (seven-digit key). */
export const eligibilityTransition = (input: IntervalInput): Transition => ({ at: keyPlusMs(input.from, SIGNIN_RETENTION_MS), strict: true });
/** Every transition of a sign-in page that the cursor must not outlive (correlation and sign-in list alike). */
export function signInTransitions(input: IntervalInput, coverage: Transition[], earliestExpiryMs: number | null, contributors: readonly ConflictContributor[]): Transition[] {
  return [...coverage, ...(earliestExpiryMs === null ? [] : [transitionAt(new Date(earliestExpiryMs))]), ...contributorTransitions(contributors),
    eligibilityTransition(input)];
}

/** A verified cursor of this page, or null; its expiry is decided first against the snapshot clock. */
export function pageClaims(key: CursorKey, cursor: string | null): CursorClaims | null {
  return cursor === null ? null : verifyCursor(key, cursor);
}
export function assertUnexpired(claims: CursorClaims | null, clock: DbClock): void {
  if (claims && clock.now.getTime() >= claims.e) throw cursorExpired();
}

export function readCorrelation(db: PrismaClient, actor: Actor, scope: Scope, raw: unknown, deps: ReadDeps): Promise<CorrelationContextV1> {
  const auth = { actor, scope, permissions: READ_PERMISSIONS, deniedEvent: CORRELATION_DENIED_EVENT };
  return guardedRead(db, auth, async () => {
    const input = parseCorrelationInput(raw);
    const key = requireCursorKey(deps.cursorKey);
    const claims = pageClaims(key, input.cursor);
    return withReadSnapshot(db, auth, (tx, clock) => correlationPage(tx, actor, scope, input, key, claims, deps, clock));
  });
}

/**
 * One correlation page inside the caller's snapshot transaction (scope and current authority already established there);
 * `clock` is the snapshot's database clock. Exported for deterministic boundary tests of the cursor rules.
 */
export async function correlationPage(tx: Prisma.TransactionClient, actor: Actor, scope: Scope, input: CorrelationInput, key: CursorKey,
  claims: CursorClaims | null, deps: ReadDeps, clock: DbClock): Promise<CorrelationContextV1> {
  assertUnexpired(claims, clock);
  assertInterval(input, clock);
  const connection = await readSelectedConnection(tx, scope, input.connectionId);
  assertReadable(connection);
  const source = await loadSource(tx, scope, input.observationId);
  const mapping = await loadMappings(tx, scope, connection.id, source, clock);
  const resolution = resolve(source, mapping, clock);
  const assessed = assessCoverage(await loadRoots(tx, scope, connection.id, input.from, input.to), await loadCapability(tx, scope, connection.id),
    input.from, input.to, clock);
  const spec: SelectionSpec = { scope, connectionId: connection.id, from: input.from, to: input.to, clock, published: assessed.published,
    routes: { deviceRef: resolution.deviceRef, userRef: resolution.userRef } };
  const available = assessed.coverage.status !== 'UNAVAILABLE';
  const stats = available ? await selectionStats(tx, spec) : { total: 0, earliestExpiryMs: null };
  const contributors = available ? await conflictContributors(tx, spec) : [];
  const userUsable = ['FRESH', 'STALE'].includes(directoryUsability(mapping.directory.m365_user, clock));
  const userGenerationId = userUsable ? mapping.directory.m365_user!.activeGenerationId : null;
  const binding = digestOf({ op: 'atlas.correlation.v1', workspaceId: scope.workspaceId, clientId: scope.clientId, actorId: actor.id,
    permissions: [...READ_PERMISSIONS].sort(), observationId: input.observationId, connectionId: connection.id, from: input.from, to: input.to, limit: input.limit });
  const fingerprint = digestOf({ connection: [connection.status, connection.lifecycleVersion],
    source: [source.sourceConnection.id, source.sourceConnection.status, source.sourceConnection.lifecycleVersion, source.reference.kind, source.agentEntityId,
      source.sourceLinks.map(l => [l.id, l.entityId]), source.device ? [source.device.id, source.device.personId] : null],
    mapping: [mapping.deviceLinks.map(l => [l.id, l.externalEntityId]), mapping.personLinks.map(l => [l.id, l.externalEntityId]),
      directoryFingerprint(mapping.directory.m365_device), directoryFingerprint(mapping.directory.m365_user), mapping.deviceObject, mapping.userObject],
    coverage: assessed.fingerprint, conflicts: contributorFingerprint(contributors),
    userLinks: available ? await userLinkDigest(tx, scope, connection.id) : null });
  if (claims) checkCursor(claims, clock.now.getTime(), binding, fingerprint);
  const after = claims ? await positionOf(tx, spec, claims.p) : null;
  if (claims && !after) throw cursorExpired(); // MAC-valid position no longer in the eligible snapshot: no fallback
  const rows = available ? await selectionPage(tx, spec, after, input.limit) : [];
  const pageRows = rows.slice(0, input.limit);
  const more = rows.length > input.limit;
  const conflicted = conflictedSources(contributors);
  const users = await loadSignInUsers(tx, scope, connection.id, userGenerationId, pageRows.flatMap(r => (r.userId ? [r.userId] : [])));
  const transitions = [...signInTransitions(input, assessed.transitions, stats.earliestExpiryMs, contributors),
    ...directoryTransitions(mapping.directory.m365_device, clock), ...directoryTransitions(mapping.directory.m365_user, clock)];
  const nextCursor = more ? issueCursor(key, { b: binding, f: fingerprint, p: pageRows.at(-1)!.id, e: cursorExpiry(clock, transitions) }) : null;
  const items = available ? pageRows.map(r => correlationItem(r, resolution, conflicted, users, userGenerationId)) : null;
  await auditRead(tx, scope, actor, deps.correlationId, { observationId: source.observationId, connectionId: connection.id, ruleVersion: CORRELATION_RULE_VERSION,
    itemCount: String(items?.length ?? 0), total: String(stats.total), coverageStatus: assessed.coverage.status });
  return { contractVersion: CORRELATION_CONTRACT_VERSION, mode: 'db', workspaceId: scope.workspaceId, clientId: scope.clientId,
    observationId: source.observationId, m365ConnectionId: connection.id, ruleVersion: CORRELATION_RULE_VERSION, source: { ...source.source },
    window: { fromInclusive: input.from, toExclusive: input.to },
    resources: [directoryResource('m365_device', mapping.directory.m365_device, clock), directoryResource('m365_user', mapping.directory.m365_user, clock),
      assessed.resource],
    resolution: { device: resolution.device, person: resolution.person, reasonCodes: resolution.reasonCodes },
    items, coverage: assessed.coverage, total: stats.total, truncated: more, nextCursor };
}

/** The client audit of a successful read: allowlisted local IDs, counts, codes and version only. */
export async function auditRead(tx: Prisma.TransactionClient, scope: Scope, actor: Actor, correlationId: string | undefined, metadata: Record<string, string>,
  eventType = 'correlation.read'): Promise<void> {
  await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, eventType, correlationId ?? randomUUID(), metadata), select: { id: true } });
}
