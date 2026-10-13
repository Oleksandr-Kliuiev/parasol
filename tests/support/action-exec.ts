import { writeFile } from 'node:fs/promises';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import type { ActionPorts, CreateTicket, PortCall, ReadTicket, TicketRecord } from '../../packages/actions/mock-port.ts';
import { executeAction } from '../../packages/actions/execution.ts';
import type { ExecuteOptions } from '../../packages/actions/execution.ts';
import { verifyAction } from '../../packages/actions/verification.ts';
import { recoverAction } from '../../packages/actions/recovery.ts';
import { CA, MOCK, WA, scoped, tokens } from './action-fixtures.ts';
import { as, assertPublic } from './action-approval.ts';
import type { PrivateFiles, Stored } from './action-approval.ts';

/**
 * Stage 3 S3-C test support. The execution services take the trusted built-in port; these tests wrap it (TEST-ONLY) to
 * count every create/read invocation and inject bounded faults at the private port — exceptions, 429/5xx-like failures,
 * malformed IDs, a commit followed by a lost response, held or late replies, tampered records. Production code never
 * imports this module. Action rows and synthetic tickets are observed through the confined runtime under explicit scope.
 */
const READ = ['context:read', 'actions:read'];
export const S3C_ACTORS: Record<string, Record<string, string[]>> = {
  executor2: { [CA]: [...READ, 'actions:execute'] },
  executorB: { 'act-client-b': [...READ, 'actions:execute'] },
  executeOnly: { [CA]: ['actions:read', 'actions:execute'] },
};
export async function addExecutionActors(owner: pg.Client): Promise<void> {
  for (const [id, memberships] of Object.entries(S3C_ACTORS)) {
    tokens[id] = generateToken();
    await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor')`, [WA, id]);
    for (const [client, permissions] of Object.entries(memberships)) {
      await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [WA, client, id, permissions]);
    }
    await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [WA, `tok-${id}`, id, hashToken(tokens[id]!)]);
  }
}

export interface CreateCall { base(): Promise<string>; input: CreateTicket; signal: AbortSignal; call: PortCall }
export interface ReadCall { base(): Promise<TicketRecord | null>; input: ReadTicket; signal: AbortSignal; call: PortCall }
/** A fresh un-aborted invocation with its own full 15 s window (test-side direct store calls and scripted `base()`). */
export const freshCall = (ms = 15_000): PortCall => ({ signal: new AbortController().signal, deadline: performance.now() + ms });
export interface Script { create?(call: CreateCall): Promise<string>; read?(call: ReadCall): Promise<TicketRecord | null> }
/** The built-in port behind a counting, optionally scripted wrapper. `base()` performs the real store call (its own fresh call). */
export function scriptedPorts(db: PrismaClient, script: Script = {}): { ports: ActionPorts; calls: { create: number; read: number }; script: Script } {
  const builtIn = mockActionPorts(db);
  const calls = { create: 0, read: 0 };
  const ports: ActionPorts = { ticketPort(binding) {
    const port = builtIn.ticketPort(binding);
    return {
      createOne(input, call) {
        calls.create++;
        return script.create ? script.create({ base: () => port.createOne(input, freshCall()), input, signal: call.signal, call }) : port.createOne(input, call);
      },
      readOne(input, call) {
        calls.read++;
        return script.read ? script.read({ base: () => port.readOne(input, freshCall()), input, signal: call.signal, call }) : port.readOne(input, call);
      },
    };
  } };
  return { ports, calls, script };
}
/** A promise the test resolves explicitly (held port replies). */
export function gate<T = void>(): { promise: Promise<T>; release(value: T): void; reached: Promise<void>; arrive(): void } {
  let release!: (value: T) => void; let arrive!: () => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  return { promise, release, reached, arrive };
}
/** A port failure that carries an HTTP-like status (429/5xx do not prove non-creation). */
export const statusError = (status: number) => Object.assign(new Error(`synthetic upstream ${status}`), { status });

export const exec = (db: PrismaClient, ports: ActionPorts, r: Stored, actor = 'executor', options?: ExecuteOptions) =>
  executeAction(db, MOCK, ports, as(actor), CA, r.requestId, r.inputHash, options);
export const verify = (db: PrismaClient, ports: ActionPorts, r: Stored, actor = 'executor', file?: string) =>
  verifyAction(db, MOCK, ports, as(actor), CA, r.requestId, file);
export const recover = (db: PrismaClient, r: Stored, actor = 'executor') => recoverAction(db, MOCK, as(actor), CA, r.requestId);

/** A protected reconciliation file (0600, outside any checkout) naming one candidate ticket for `requestId`. */
export async function candidateFile(files: PrivateFiles & { dir?: string }, requestId: string, candidateTicketId: string, extra: Record<string, unknown> = {}): Promise<string> {
  return files.input({ kind: 'ACTION_RECONCILIATION_CANDIDATE', dto: 'action-candidate/1', requestId, candidateTicketId, ...extra });
}
export const writePrivate = (path: string, text: string, mode = 0o600) => writeFile(path, text, { mode });

/** Runtime-scoped observation of S3-C rows (never the owner on FORCE tables). */
export function observeExec(runtime: pg.Client, client = CA) {
  const rows = <T = Record<string, any>>(sql: string, params: unknown[]) => scoped<T>(runtime, WA, client, sql, params);
  return {
    attempt: async (requestId: string) => (await rows(`SELECT * FROM "ActionAttempt" WHERE "requestId" = $1`, [requestId]))[0] ?? null,
    request: async (requestId: string) => (await rows(`SELECT * FROM "ActionRequest" WHERE id = $1`, [requestId]))[0] ?? null,
    verifications: (requestId: string) => rows(`SELECT v.* FROM "ActionVerification" v JOIN "ActionAttempt" a ON a."workspaceId" = v."workspaceId"
      AND a."clientId" = v."clientId" AND a.id = v."attemptId" WHERE a."requestId" = $1 ORDER BY v.ordinal`, [requestId]),
    /** Test-side lookup of the synthetic tickets carrying this request's marker (production never searches). */
    tickets: async (requestId: string) => (await rows<{ id: string }>(`SELECT id::text AS id FROM "ActionMockTicket" WHERE "markedTitle" LIKE '%' || $1 || ']' ORDER BY "createdAt", id`,
      [requestId])).map(t => t.id),
    audit: (requestId: string) => rows<{ eventType: string; metadata: Record<string, string> }>(`SELECT "eventType", metadata FROM "AuditEvent"
      WHERE metadata->>'actionRequestId' = $1 ORDER BY "recordedAt", id`, [requestId]),
  };
}
/** Public result/audit privacy: no body/customer/token material and no synthetic ticket ID of this request. */
export function assertNoTicketIds(value: unknown, ticketIds: readonly string[], label: string): void {
  assertPublic(value, label);
  const text = JSON.stringify(value);
  for (const id of ticketIds) assert.ok(!text.includes(id), `${label}: a ticket ID leaked`);
}

/**
 * Owner-installed AuditEvent fault for one event type: the first `times` inserts fail with `errcode` (40001 = a known
 * rollback; anything else an audit-store failure). A non-transactional sequence counts across rolled-back attempts. The
 * SECURITY DEFINER helper holds no PUBLIC EXECUTE (triggers fire without it), so the readiness facts stay unchanged.
 */
export async function auditFault(owner: pg.Client, eventType: string, times: number, errcode = 'P0001'): Promise<{ remove(): Promise<void> }> {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  await owner.query(`DROP TRIGGER IF EXISTS test_audit_fault ON "AuditEvent"; DROP SEQUENCE IF EXISTS test_audit_fault_seq; CREATE SEQUENCE test_audit_fault_seq;
    CREATE OR REPLACE FUNCTION test_audit_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF NEW."eventType" = ${lit(eventType)} THEN
        IF nextval('test_audit_fault_seq') <= ${Number(times)} THEN RAISE EXCEPTION 'CANARY audit fault' USING ERRCODE = ${lit(errcode)}; END IF;
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION test_audit_fault() FROM PUBLIC;
    CREATE TRIGGER test_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_audit_fault();`);
  return { remove: async () => { await owner.query(`DROP TRIGGER IF EXISTS test_audit_fault ON "AuditEvent"; DROP FUNCTION IF EXISTS test_audit_fault();
    DROP SEQUENCE IF EXISTS test_audit_fault_seq;`); } };
}

/**
 * In-process network trap: while `fn` runs, every native network entry point (net/tls sockets, http/https requests, DNS,
 * global fetch) is replaced by a recorder that throws. Prisma's engine is native code (no Node socket); the test's pg
 * observers are already connected and must not be used inside `fn`.
 */
export async function withNetworkTrap<T>(fn: () => Promise<T>): Promise<{ result: T; attempts: string[] }> {
  const attempts: string[] = [];
  const restore: (() => void)[] = [];
  const patch = (target: any, key: string, label: string) => {
    const original = target[key];
    target[key] = function trapped() { attempts.push(label); throw new Error(`network trap: ${label}`); };
    restore.push(() => { target[key] = original; });
  };
  patch(net.Socket.prototype, 'connect', 'net.Socket.connect'); patch(net, 'connect', 'net.connect'); patch(net, 'createConnection', 'net.createConnection');
  patch(tls, 'connect', 'tls.connect'); patch(http, 'request', 'http.request'); patch(http, 'get', 'http.get'); patch(https, 'request', 'https.request');
  patch(https, 'get', 'https.get'); patch(dns, 'lookup', 'dns.lookup'); patch(dns.promises, 'lookup', 'dns.promises.lookup'); patch(globalThis, 'fetch', 'fetch');
  try { return { result: await fn(), attempts }; } finally { for (const undo of restore.reverse()) undo(); }
}
