import type pg from 'pg';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../packages/core/contracts.ts';
import { injectedCursorKey } from '../../packages/correlation/cursor.ts';
import type { ReadDeps } from '../../packages/correlation/read.ts';
import { createM365SignInRequest, requeueM365RootJob } from '../../packages/m365/windows.ts';
import { runM365SignInRequest } from '../../packages/m365/ingest.ts';
import type { SignInRunOptions } from '../../packages/m365/ingest.ts';
import type { Clock } from '../../packages/m365/io.ts';
import { guid } from '../m365-sql-invariants.ts';
import { WS, gasta } from './graph-fixtures.ts';
import { M365_CONNECTION, M365_TENANT, m365Actors } from './m365-fixtures.ts';
import { mockM365 } from './m365-graph-mock.ts';
import { signInRoute } from './m365-signin-mock.ts';
import type { SignInData, SignInRouteOptions } from './m365-signin-mock.ts';
import { ioOf } from './m365-pg.ts';

/**
 * Synthetic correlation scenario for the S2-C PostgreSQL tests (no real tenant ID, user, device or credential):
 *   Huntress (seed): agent demo-huntress-agent-207 → CONFIRMED → DEVICE demo-device-07 (personId demo-kari).
 *   Directory: device object LAPTOP_OBJECT with registration deviceId LAPTOP_REGISTRATION (≠ its id); user object KARI_OBJECT.
 *   Links m365-device-07 → demo-device-07 and m365-user-kari → demo-kari (fixtures start CANDIDATE; confirmM365Links).
 * Directory rows are published as owner (the S2-A fixture path, triggers apply) with second precision; sign-in windows are
 * published through the accepted S2-B services against the captured Graph mock, optionally with a shifted clock.
 */
export const CURSOR_SECRET = 'synthetic-cursor-secret-for-tests-only-0123456789';
export const readDeps = (): ReadDeps => ({ cursorKey: () => injectedCursorKey(CURSOR_SECRET) });
export const reader: Actor = { id: 'demo-m365-reader', workspaceId: WS, workspacePermissions: [], memberships: [{ clientId: 'demo-gasta', permissions: ['context:read', 'm365:read'] }] };
export const OTHER_USER = guid('d'); export const OTHER_DEVICE = guid('e');
export const KARI = guid('a'); export const LAPTOP = guid('b'); export const REGISTRATION = guid('c');

export async function addReader(owner: pg.Client, actor: Actor = reader): Promise<void> {
  await owner.query(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ($1,$2,'Synthetic actor') ON CONFLICT DO NOTHING`, [WS, actor.id]);
  for (const m of actor.memberships) {
    await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ($1,$2,$3,$4)
      ON CONFLICT ("workspaceId","clientId","actorId") DO UPDATE SET permissions = EXCLUDED.permissions`, [WS, m.clientId, actor.id, m.permissions]);
  }
}

let events = 0;
/** A synthetic Huntress observation; `device` undefined → the seed agent, null → no reference, any other value as stored. */
export async function addHuntressObservation(owner: pg.Client, id: string, device: unknown = { resourceType: 'agent', externalId: 'demo-huntress-agent-207' },
  connectionId = 'demo-huntress-connection', source = 'huntress'): Promise<void> {
  const n = ++events;
  const normalized = { workspaceId: WS, clientId: 'demo-gasta', source, connectionId, resourceType: 'incident', externalEventId: `inc-${id}`, revision: '1',
    externalDevice: device, occurredAt: '2026-10-07T06:40:00.000Z', receivedAt: '2026-10-07T06:41:00.000Z', kind: 'SECURITY_INCIDENT', sourceSeverity: 'CRITICAL',
    summary: 'Synthetic incident', facts: {} };
  await owner.query(`INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized",
    "payloadHash","occurredAt","status") VALUES ($1,'demo-gasta',$2,$3,'incident',$4,'1',$5,$6,$7,now(),'PROCESSED')`,
  [WS, `raw-${id}`, connectionId, `inc-${id}`, `synthetic-event-key-${id}-${n}`, JSON.stringify(normalized), `hash-${n}`]);
  await owner.query(`INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence",
    "provider","promptVersion","reasonCodes") VALUES ($1,'demo-gasta',$2,$3,'demo-device-07','SECURITY','CRITICAL',4,'URGENT','HUMAN_REVIEW',1,'rules','rules-v1','{SOURCE_CRITICAL}')`,
  [WS, id, `raw-${id}`]);
}

/** CONFIRMED (owner write, fixture path) — the read side only needs the stored decision. */
export async function confirmLinks(owner: pg.Client, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await owner.query(`UPDATE "EntityLink" SET status = 'CONFIRMED', "confirmedBy" = 'demo-m365-reviewer', "confirmedAt" = now(), "reviewedBy" = 'demo-m365-reviewer',
      "reviewedAt" = now() WHERE id = $1`, [id]);
  }
}
export const confirmM365Links = (owner: pg.Client) => confirmLinks(owner, 'link-m365-device', 'link-m365-user');

export interface DirectoryObject { source: string; mirror: string; deviceId?: string | null; displayName?: string }
/**
 * Publishes a directory generation as owner: `completedSecondsAgo` before now, retained `retainSeconds` after completion
 * (≤ 24h). Mirrors must exist (ExternalEntity of the same connection/type/source ID).
 */
export async function publishGeneration(owner: pg.Client, type: 'm365_user' | 'm365_device', gen: string, objects: DirectoryObject[],
  completedSecondsAgo = 60, retainSeconds = 24 * 3600, connectionId = M365_CONNECTION, clientId = 'demo-gasta'): Promise<void> {
  const version = Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [connectionId])).rows[0].v);
  const [{ seq }] = (await owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq","attemptsUsed")
    VALUES ($1,$4,$2,$3,1,0) ON CONFLICT ("workspaceId","clientId","connectionId","resourceType") DO UPDATE SET "latestStartedSeq" = "M365ResourceState"."latestStartedSeq" + 1,
    "attemptsUsed" = "M365ResourceState"."attemptsUsed" + 1 RETURNING "latestStartedSeq" AS seq`, [WS, connectionId, type, clientId])).rows;
  const completed = `now() - make_interval(secs => ${completedSecondsAgo})`;
  await owner.query(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","startedAt","expiresAt") VALUES ($1,$7,$2,$3,$4,$5,$6,gen_random_uuid(),now() + interval '10 minutes',${completed} - interval '1 second',
    ${completed} + interval '1 hour')`, [WS, connectionId, type, gen, seq, version, clientId]);
  for (const o of objects) {
    const dto = type === 'm365_device'
      ? { id: o.source, deviceId: o.deviceId ?? null, displayName: o.displayName ?? 'SYNTH-LT (synthetic)', accountEnabled: true, operatingSystem: 'Windows' }
      : { id: o.source, displayName: 'Synthetic User', userPrincipalName: 'synthetic@example.invalid', userType: 'MEMBER', accountEnabled: true };
    await owner.query(`INSERT INTO "M365DirectoryObject" VALUES ($1,$9,$2,$3,$4,$5,$6,$7,$8)`,
      [WS, connectionId, type, gen, o.source, o.mirror, type === 'm365_device' ? o.deviceId ?? null : null, JSON.stringify(dto), clientId]);
  }
  await owner.query('BEGIN');
  try {
    await owner.query(`UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = ${completed}, "claimToken" = NULL, "leaseExpiresAt" = NULL,
      "rowCount" = $3, "expiresAt" = ${completed} + make_interval(secs => $4) WHERE "connectionId" = $1 AND id = $2`, [connectionId, gen, objects.length, retainSeconds]);
    await owner.query(`UPDATE "M365ResourceState" SET "activeGenerationId" = $3, "latestPublishedSeq" = $4, "latestRecordedSeq" = $4, status = 'OK', "attemptsUsed" = 0,
      "safeErrorCode" = NULL, "lastAttemptAt" = ${completed}, "lastSuccessAt" = ${completed} WHERE "connectionId" = $1 AND "resourceType" = $2`, [connectionId, type, gen, seq]);
    await owner.query('COMMIT');
  } catch (error) { await owner.query('ROLLBACK'); throw error; }
}
/** The standard scenario directory: device LAPTOP (registration REGISTRATION) and user KARI, both fresh. */
export async function publishScenarioDirectory(owner: pg.Client, suffix = '1', completedSecondsAgo = 60): Promise<void> {
  await publishGeneration(owner, 'm365_device', `gen-device-${suffix}`, [{ source: LAPTOP, mirror: 'm365-device-07', deviceId: REGISTRATION }], completedSecondsAgo);
  await publishGeneration(owner, 'm365_user', `gen-user-${suffix}`, [{ source: KARI, mirror: 'm365-user-kari' }], completedSecondsAgo);
}

/** Sign-in row of the scenario: device/user references as given (null = absent). */
export const signIn = (id: string, at: string, userId: string | null, deviceId: string | null, extra: Record<string, unknown> = {}): SignInData =>
  ({ id, at, extra: { userId, deviceDetail: { deviceId, displayName: 'DROP-ME' }, ...extra } });

/**
 * One operator sign-in request over [from, to) and one pass through the S2-B services against the Graph mock returning
 * `rows`; `clock` shifts the decision time (publishedAt/coverage) for freshness tests.
 */
export async function publishSignIns(db: PrismaClient, rows: () => readonly SignInData[], from: Date, to: Date, clock?: Clock, connectionId = M365_CONNECTION,
  tenant = M365_TENANT, route: SignInRouteOptions = {}, run: SignInRunOptions = {}) {
  const mock = mockM365(tenant, { route: signInRoute(rows, route) });
  const request = await createM365SignInRequest(db, m365Actors.syncer, gasta, connectionId, from, to, clock);
  const results = await runM365SignInRequest(db, m365Actors.syncer, gasta, connectionId, request.requestId, ioOf(mock), clock, run);
  return { requestId: request.requestId, results, mock };
}
export { requeueM365RootJob };
/** Epoch-ms timestamps read as UTC from the owner connection. */
export const ms = async (owner: pg.Client, sql: string, params: unknown[] = []) => Number((await owner.query(sql, params)).rows[0].v);
