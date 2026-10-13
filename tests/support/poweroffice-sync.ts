import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { builtInExportPort } from '../../connectors/poweroffice/builtin.ts';
import type { PageControl } from '../../connectors/poweroffice/contract.ts';
import { ExportAccumulator } from '../../packages/poweroffice/export.ts';
import type { InvoiceSummary } from '../../packages/poweroffice/contracts.ts';
import { testFaultComposition } from '../../packages/poweroffice/composition.ts';
import type { PowerOfficeComposition, SourceFaultCall } from '../../packages/poweroffice/composition.ts';
import { inTx } from './poweroffice-fixtures.ts';
import type { PoKey } from './poweroffice-fixtures.ts';

/**
 * S4-B TRUSTED TEST SUPPORT. Synthetic FIXTURE connections whose company UUID selects the built-in export size (its last
 * 12 hex digits modulo 251, connectors/poweroffice/builtin.ts), the private in-process fault seam with a call log, an
 * independent re-computation of the expected aggregate through the built-in port itself, and observers of the domain rows
 * (through the confined runtime under an explicit scope) and of the audit rows (owner). No production path uses any of it.
 */
let serial = 0;
/** A fresh synthetic company UUID whose built-in export has exactly `items` (0..250) invoices. */
export function companyUuidFor(items: number): string {
  serial++;
  const value = BigInt(items) + 251n * BigInt(4096 + serial);
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}
export interface SyncConnection extends PoKey { readonly companyKey: string }
/** Owner-inserted FIXTURE PowerOffice connection with the fixed synthetic binding and provenance (test fixture only). */
export async function addSyncConnection(owner: pg.Client, key: PoKey, items: number, options: { status?: string; version?: number; bound?: boolean } = {}): Promise<SyncConnection> {
  const company = companyUuidFor(items);
  const bound = options.bound ?? true;
  await owner.query(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status,"boundBy","boundAt","lifecycleVersion")
    VALUES ($1,$2,$3,'poweroffice',$4,$5,$6,$7,$8,$9)`, [key.workspaceId, key.clientId, key.connectionId, `synthetic-po-${company}`,
    `fixture://poweroffice/${company}`, options.status ?? 'FIXTURE', bound ? 'operator' : null, bound ? new Date() : null, options.version ?? 1]);
  return { ...key, companyKey: `synthetic-po-${company}` };
}

/** A further owner-written bearer of an existing actor (optionally expiring `expiresInMs` from the DB clock); returns the bearer. */
export async function addToken(owner: pg.Client, workspaceId: string, actorId: string, expiresInMs?: number): Promise<string> {
  const bearer = generateToken();
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, $4,
    CASE WHEN $5::int IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') + $5::int * interval '1 millisecond' END)`,
  [workspaceId, `tok-${randomUUID()}`, actorId, hashToken(bearer), expiresInMs ?? null]);
  return bearer;
}
export async function revokeToken(owner: pg.Client, bearer: string): Promise<void> {
  await owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE "tokenHash" = $1`, [hashToken(bearer)]);
}
/**
 * Superuser fixture (replica mode, row triggers and FK checks off; CHECKs still apply): `n` old FAILED attempts with
 * sequences 1..n and the coherent State of a connection that has no State yet — the retention cap without 1000 real syncs.
 */
export async function seedRetainedAttempts(admin: pg.Client, key: PoKey, n: number, actorId = 'syncer'): Promise<void> {
  const k = [key.workspaceId, key.clientId, key.connectionId];
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId",
        "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt", state, "completedAt", "safeErrorCode")
      SELECT $1, $2, $3, gen_random_uuid(), g, gen_random_uuid(), gen_random_uuid(), 1, $4, gen_random_uuid(), x.t, x.t + interval '60 seconds',
             x.t + interval '80 seconds', 'FAILED', x.t + interval '1 second', 'POWEROFFICE_SOURCE_FAILED'
        FROM generate_series(1, $5::int) g, LATERAL (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') - interval '3 days' + g * interval '1 second' AS t) x`,
    [...k, actorId, n]);
    await admin.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId", "nextSequence", "lastAttemptId", "lastAttemptState",
        "lastAttemptErrorCode", "lastCompletedAttemptId", "lastCompletedState", "lastCompletedErrorCode")
      SELECT $1, $2, $3, $4::int + 1, a.id, 'FAILED', 'POWEROFFICE_SOURCE_FAILED', a.id, 'FAILED', 'POWEROFFICE_SOURCE_FAILED'
        FROM public."PowerOfficeAttempt" a WHERE a."workspaceId" = $1 AND a."clientId" = $2 AND a."connectionId" = $3 AND a.sequence = $4::int`, [...k, n]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK').catch(() => undefined); throw error; }
}

/** Every page call the fault seam saw: ordinal, the control's deadline and whether its signal was aborted at the end. */
export interface SeamCall { ordinal: number; startedAt: number; monotonicDeadline: number; control: PageControl; outcome?: string }
export interface Seam { composition: PowerOfficeComposition; calls: SeamCall[] }
/** A fault composition; `fault` defaults to the plain built-in call. Every call is logged before the fault runs. */
export function seam(fault: (call: SourceFaultCall, log: SeamCall) => Promise<unknown> = call => call.builtIn()): Seam {
  const calls: SeamCall[] = [];
  const composition = testFaultComposition(async call => {
    const log: SeamCall = { ordinal: call.ordinal, startedAt: performance.now(), monotonicDeadline: call.control.monotonicDeadline, control: call.control };
    calls.push(log);
    try { const page = await fault(call, log); log.outcome ??= 'page'; return page; }
    catch (error) { log.outcome ??= 'rejected'; throw error; }
  });
  return { composition, calls };
}
/** Deep plain copy of a page (the seam may then change it). */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The aggregate the built-in export of `companyKey` at `asOf` must yield, recomputed independently of the services. */
export async function expectedSummary(connectionId: string, companyKey: string, asOf: string, attemptId: string): Promise<InvoiceSummary> {
  const port = builtInExportPort();
  const session = port.openSession({ connectionId, companyKey, lifecycleVersion: 1, attemptId, asOf });
  const acc = new ExportAccumulator({ companyKey, asOf });
  try {
    for (;;) {
      const page = await port.readPage(session, acc.expectedOrdinal, { signal: new AbortController().signal, monotonicDeadline: performance.now() + 10_000 });
      if (acc.accept(page)) return acc.summary();
    }
  } finally { acc.dispose(); port.closeSession(session); }
}
/** Every invoice ID the built-in export of `companyKey` contains (to prove none was persisted anywhere). */
export async function syntheticInvoiceIds(connectionId: string, companyKey: string, asOf: string, attemptId: string): Promise<string[]> {
  const port = builtInExportPort();
  const session = port.openSession({ connectionId, companyKey, lifecycleVersion: 1, attemptId, asOf });
  const ids: string[] = [];
  try {
    for (let ordinal = 1; ; ordinal++) {
      const page = await port.readPage(session, ordinal, { signal: new AbortController().signal, monotonicDeadline: performance.now() + 10_000 }) as
        { items: { id: string }[]; hasMore: boolean };
      ids.push(...page.items.map(i => i.id));
      if (!page.hasMore) return ids;
    }
  } finally { port.closeSession(session); }
}

/** Domain rows of one connection as the confined runtime sees them under that connection's scope. */
export async function observe(runtime: pg.Client, key: PoKey) {
  return inTx(runtime, { workspaceId: key.workspaceId, clientIds: key.clientId, connectionId: key.connectionId }, async c => {
    const k = [key.workspaceId, key.clientId, key.connectionId];
    const W = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
    const state = (await c.query(`SELECT "nextSequence" AS next, "activeAttemptId"::text AS active, "snapshotId"::text AS pointer, "snapshotVersion" AS "pointerVersion",
      "lastAttemptId"::text AS "lastAttempt", "lastAttemptState", "lastAttemptErrorCode", "lastCompletedAttemptId"::text AS "lastCompleted", "lastCompletedState",
      "lastCompletedErrorCode", "lastSuccessAt"::text AS "lastSuccessAt" FROM public."PowerOfficeState" WHERE ${W}`, k)).rows[0] ?? null;
    const attempts = (await c.query(`SELECT id::text AS id, sequence, state, "safeErrorCode", "lifecycleVersion", "allocatedSnapshotId"::text AS allocated,
      "completedAt" IS NOT NULL AS completed FROM public."PowerOfficeAttempt" WHERE ${W} ORDER BY sequence`, k)).rows;
    const snapshots = (await c.query(`SELECT id::text AS id, "attemptId"::text AS "attemptId", "lifecycleVersion", summary, "businessDate"::text AS "businessDate",
      to_char("asOf", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf", synthetic FROM public."PowerOfficeSnapshot" WHERE ${W} ORDER BY "publishedAt"`, k)).rows;
    return { state, attempts, snapshots };
  });
}
/** Client audit rows of PowerOffice events for one connection (owner read), oldest first. */
export async function audits(owner: pg.Client, connectionId?: string) {
  return (await owner.query(`SELECT id, "workspaceId", "clientId", "actorId", "eventType", "correlationId", metadata FROM "AuditEvent"
    WHERE "eventType" LIKE 'poweroffice.%' ${connectionId ? `AND metadata->>'connectionId' = $1` : ''} ORDER BY "recordedAt", id`, connectionId ? [connectionId] : [])).rows;
}
export async function denials(owner: pg.Client) {
  return (await owner.query(`SELECT "actorId", "eventType", "requestedClientId", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "eventType" LIKE 'poweroffice.%' ORDER BY "recordedAt", id`)).rows;
}
/** Fixed code of a settled promise ('ok' when it resolved). */
export const codeOf = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e?.code ?? 'NO_CODE');
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Waits until a backend of this database waits on a lock while running SQL that matches `pattern` (owner observation). */
export async function untilWaiting(owner: pg.Client, pattern: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [`%${pattern}%`]);
    if (r.rows[0].n > 0) return;
    if (Date.now() > until) throw new Error(`no backend waiting on ${pattern}`);
    await sleep(20);
  }
}
