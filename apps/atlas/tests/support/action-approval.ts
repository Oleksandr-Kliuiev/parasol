import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { exportStoredPreview, previewAction, requestAction } from '../../packages/actions/requests.ts';
import { approveAction } from '../../packages/actions/approvals.ts';
import { reserveAction } from '../../packages/actions/reservation.ts';
import { CA, CUSTOMER_CANARY, MOCK, WA, scoped, tokens } from './action-fixtures.ts';
import { openSession } from './pg-race.ts';
import type { Session } from './pg-race.ts';

/**
 * Stage 3 S3-B test support: the extra synthetic actors (owner-written BEFORE the requests of a test, since every auth
 * mutation moves the epoch), a request → stored-preview approval → reservation flow through the real services, runtime-
 * scoped observation of action rows, and lock-queue orderings: a held fence row makes later fenced transactions queue in
 * FIFO order, observed through pg_locks (never a sleep).
 */
// Timestamps without time zone hold UTC (codebase convention, as Prisma reads them): parse them so in these test processes.
pg.types.setTypeParser(1114, (value: string) => new Date(`${value.replace(' ', 'T')}Z`));
const READ = ['context:read', 'actions:read'];
export const S3B_ACTORS: Record<string, Record<string, string[]>> = {
  approver2: { [CA]: [...READ, 'actions:approve'] },
  approverB: { 'act-client-b': [...READ, 'actions:approve'] },
  executor: { [CA]: [...READ, 'actions:execute'] },
  dual: { [CA]: [...READ, 'actions:request', 'actions:approve'] },
  splitApprover: { [CA]: READ, 'act-client-b': ['context:read', 'actions:approve'] },
  executeNoRead: { [CA]: ['context:read', 'actions:execute'] },
};
export async function addApprovalActors(owner: pg.Client): Promise<void> {
  for (const [id, memberships] of Object.entries(S3B_ACTORS)) {
    tokens[id] = generateToken();
    await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor')`, [WA, id]);
    for (const [client, permissions] of Object.entries(memberships)) {
      await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [WA, client, id, permissions]);
    }
    await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [WA, `tok-${id}`, id, hashToken(tokens[id]!)]);
  }
}

export const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code && e.message === code;
export const as = (actor: string) => actionCredential(tokens[actor]!);
const PRIVATE = () => [/CANARY/, new RegExp(CUSTOMER_CANARY), /fixture:\/\//, /tok-/, /"(attemptToken|createNonce|signerTokenId)"/,
  ...Object.values(tokens).map(t => new RegExp(hashToken(t)))];
/** No body, customer key, secret reference, token row/digest or nonce in a public result or audit row. */
export function assertPublic(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  for (const p of PRIVATE()) assert.doesNotMatch(text, p, label);
}

export interface PrivateFiles { input(value: unknown, name?: string): Promise<string>; out(name: string): string }
export interface Stored { requestId: string; inputHash: string; inputPreview: string }
/** The real services end to end; every step uses fresh bearer authority (no actor DTO). */
export function actionFlow(db: PrismaClient, files: PrivateFiles) {
  let n = 0;
  const next = () => files.out(`s3b-${++n}.json`);
  async function request(actor = 'requester', client = CA, connectionId = client === CA ? 'atera-a' : 'atera-b'): Promise<Stored> {
    const input = await files.input({ connectionId, title: `CANARY-title ${++n}`, description: 'CANARY-body', idempotencyKey: randomUUID() });
    const inputPreview = next();
    const p = await previewAction(db, MOCK, as(actor), client, input, inputPreview);
    const r = await requestAction(db, MOCK, as(actor), client, input, p.inputHash);
    return { requestId: r.requestId, inputHash: r.inputHash, inputPreview };
  }
  /** action-get --preview-file: the STORED preview, exported by `actor` (read + context only). */
  async function exported(actor: string, client: string, requestId: string): Promise<string> {
    const file = next();
    await exportStoredPreview(db, MOCK, as(actor), client, requestId, file);
    return file;
  }
  const approve = async (r: Stored, actor = 'approver', client = CA) =>
    approveAction(db, MOCK, as(actor), client, r.requestId, r.inputHash, await exported(actor, client, r.requestId));
  async function approved(requester = 'requester', approver = 'approver'): Promise<Stored> {
    const r = await request(requester);
    await approve(r, approver);
    return r;
  }
  const reserve = (r: Stored, actor = 'executor', client = CA) => reserveAction(db, MOCK, as(actor), client, r.requestId, r.inputHash);
  return { next, request, exported, approve, approved, reserve };
}

/** Runtime-scoped observation (never the owner on FORCE tables). */
export function observe(runtime: pg.Client, client = CA) {
  const one = async (sql: string, id: string) => (await scoped<Record<string, any>>(runtime, WA, client, sql, [id]))[0] ?? null;
  return {
    request: (id: string) => one(`SELECT * FROM "ActionRequest" WHERE id = $1`, id),
    approval: (id: string) => one(`SELECT * FROM "ActionApproval" WHERE "requestId" = $1`, id),
    attempt: (id: string) => one(`SELECT * FROM "ActionAttempt" WHERE "requestId" = $1`, id),
    attempts: async (id: string) => (await scoped<{ n: number }>(runtime, WA, client, `SELECT count(*)::int AS n FROM "ActionAttempt" WHERE "requestId" = $1`, [id]))[0]!.n,
    audit: (id: string) => scoped<{ eventType: string; metadata: Record<string, string> }>(runtime, WA, client,
      `SELECT "eventType", metadata FROM "AuditEvent" WHERE metadata->>'actionRequestId' = $1 ORDER BY "recordedAt", id`, [id]),
    security: (workspace = WA) => scoped<{ eventType: string; reasonCode: string; requestedClientId: string; actorId: string }>(runtime, workspace, '',
      `SELECT "eventType", "reasonCode", "requestedClientId", "actorId" FROM "SecurityAuditEvent" ORDER BY "recordedAt", id`),
  };
}

/** Resolves once at least `n` backends of this database wait on a lock. */
export async function waitForWaiters(observer: pg.Client, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = (await observer.query(`SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`)).rows[0].n as number;
    if (count >= n) return;
    if (Date.now() > deadline) throw new Error(`only ${count} of ${n} sessions waited on a lock`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
/** The confined runtime holding the workspace fence row (SELECT ... FOR UPDATE) until released. */
export async function holdFence(runtimeUrl: string, workspace = WA): Promise<{ session: Session; release(): Promise<void> }> {
  const session = await openSession(runtimeUrl);
  await session.client.query('BEGIN');
  await session.client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
  await session.client.query(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [workspace]);
  return { session, release: async () => { await session.client.query('ROLLBACK'); await session.client.end(); } };
}
/** Settles to the value or the fixed error code. */
export const settle = async <T>(p: Promise<T>): Promise<T | string> => p.catch((e: unknown) => e instanceof AtlasError ? e.code : `unexpected: ${String(e)}`);
/** Milliseconds until a stored DB timestamp passes, by the DB clock (plus a small margin). */
export async function untilPassed(owner: pg.Client, at: Date): Promise<void> {
  const ms = (await owner.query(`SELECT greatest(0, extract(epoch FROM $1::timestamp - (clock_timestamp() AT TIME ZONE 'UTC')) * 1000)::int AS ms`,
    [at.toISOString().replace('Z', '')])).rows[0].ms as number;
  await new Promise(resolve => setTimeout(resolve, ms + 50));
}
/** Owner sets a token's expiry relative to the DB clock (an auth mutation: it moves the epoch, so do it before requests). */
export const expireTokenIn = (owner: pg.Client, tokenId: string, interval: string) =>
  owner.query(`UPDATE "ApiToken" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + $2::interval WHERE id = $1`, [tokenId, interval]);
