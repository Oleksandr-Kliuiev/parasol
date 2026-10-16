import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { createTestDatabase, projectRoot, runSeed } from './pg-harness.ts';
import type { PgTestDatabase } from './pg-harness.ts';

// Ask Atlas PG test support (docs/stage5/ask/04 Q2–Q6): synthetic disposable data, extra actors/tokens written by the
// owner (the accepted fence triggers bump the workspace epoch), the in-process DB API built from dist with an injected
// planner and an observable budget, and small HTTP/raw-socket helpers. No real tenant data; markers are synthetic.

export const WS = 'demo-vardahei';
export const CLIENT = 'demo-gasta';
export const MARKERS = Object.freeze({ question: 'QUESTION-SECRET-MARKER-7f3', email: 'email-marker-7f3@example.invalid', fact: 'FACT-MARKER-7f3',
  device: 'EXTDEV-MARKER-7f3', title: 'ITEM-TITLE-MARKER-7f3', planner: 'PLANNER-EXCEPTION-MARKER-7f3' });

/**
 * Gasta Ask data on top of the accepted seed: a second Atera connection (two same-system connections), resource states
 * OK/ERROR/STALE/MISSING, observations of every intent's interest, and excluded fields carrying markers.
 *   ask-crit CRITICAL huntress/incident/demo-huntress-connection, device demo-device-07 (confirmed via the Atera link first)
 *   ask-high HIGH     atera/alert/atera-two (ERROR resource), no entity
 *   ask-person MEDIUM atera/ticket/atera-two (STALE resource), person demo-kari without a confirmed link
 *   ask-low  LOW      atera/alert/demo-atera-connection (OK resource), device demo-device-07
 *   ask-notuple LOW   atera/incident/demo-atera-connection (no expected resource tuple)
 *   ask-resolved MEDIUM RESOLVED atera/alert/demo-atera-connection (outside the active page)
 */
export async function seedAsk(owner: pg.Client): Promise<void> {
  const normalized = (kind: string, summary: string) => JSON.stringify({ kind, summary, facts: { signal: MARKERS.fact },
    externalDevice: { resourceType: 'agent', externalId: MARKERS.device }, receivedAt: '2026-10-10T07:00:00.000Z' });
  const event = (id: string, connection: string, type: string, kind: string, summary: string, minutes: number) =>
    `('${WS}','${CLIENT}','ev-${id}','${connection}','${type}','ext-${id}','1','key-${id}','${normalized(kind, summary)}','hash-${id}',now() - interval '${minutes} minutes','PROCESSED')`;
  const obs = (id: string, entity: string | null, domain: string, severity: string, rank: number, minutes: number, extra = `'OPEN',NULL,NULL`) =>
    `('${WS}','${CLIENT}','${id}','ev-${id}',${entity === null ? 'NULL' : `'${entity}'`},'${domain}','${severity}',${rank},'${rank >= 3 ? 'URGENT' : 'NORMAL'}','MONITOR',0.5,'rules','rules-v1',ARRAY['RULES_BASELINE'],now() - interval '${minutes} minutes',${extra})`;
  const item = (type: string, id: string, title: string) => JSON.stringify({ source: 'atera', resourceType: type, externalId: id, title, status: 'Open',
    severity: type === 'alert' ? 'HIGH' : null, priority: null, device: { resourceType: 'agent', externalId: 'agent-1' }, occurredAt: '2026-10-10T07:00:00.000Z', updatedAt: null });
  await owner.query(`
    UPDATE "Person" SET email = '${MARKERS.email}' WHERE id = 'demo-kari';
    INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status) VALUES ('${WS}','${CLIENT}','atera-two','atera','atera-synthetic-two','fixture://no-credentials','FIXTURE');
    INSERT INTO "RawEvent" ("workspaceId","clientId",id,"connectionId","resourceType","externalEventId",revision,"eventKey",normalized,"payloadHash","occurredAt",status) VALUES
      ${event('ask-crit', 'demo-huntress-connection', 'incident', 'SECURITY_INCIDENT', 'Credential theft suspected (synthetic)', 50)},
      ${event('ask-high', 'atera-two', 'alert', 'DISK_CAPACITY', 'Disk almost full (synthetic)', 40)},
      ${event('ask-person', 'atera-two', 'ticket', 'DISK_CAPACITY', 'Ticket about a user (synthetic)', 30)},
      ${event('ask-low', 'demo-atera-connection', 'alert', 'DISK_CAPACITY', 'Low disk warning (synthetic)', 20)},
      ${event('ask-notuple', 'demo-atera-connection', 'incident', 'DISK_CAPACITY', 'Odd resource type (synthetic)', 10)},
      ${event('ask-resolved', 'demo-atera-connection', 'alert', 'DISK_CAPACITY', 'Resolved disk alert (synthetic)', 60)};
    INSERT INTO "Observation" ("workspaceId","clientId",id,"eventId","entityId",domain,severity,"severityRank",priority,route,confidence,provider,"promptVersion","reasonCodes","createdAt",status,"resolvedAt","resolvedBy") VALUES
      ${obs('ask-crit', 'demo-device-07', 'SECURITY', 'CRITICAL', 4, 50)}, ${obs('ask-high', null, 'OPERATIONS', 'HIGH', 3, 40)},
      ${obs('ask-person', 'demo-kari', 'OPERATIONS', 'MEDIUM', 2, 30)}, ${obs('ask-low', 'demo-device-07', 'OPERATIONS', 'LOW', 1, 20)},
      ${obs('ask-notuple', null, 'OPERATIONS', 'LOW', 1, 10)}, ${obs('ask-resolved', null, 'OPERATIONS', 'MEDIUM', 2, 60, `'RESOLVED',now(),'demo-technician'`)};
    INSERT INTO "SyncState" ("workspaceId","clientId","connectionId","resourceType",status,"lastSyncAt","lastSuccessAt","safeErrorCode") VALUES
      ('${WS}','${CLIENT}','demo-atera-connection','alert','OK',now(),now(),NULL),
      ('${WS}','${CLIENT}','atera-two','alert','ERROR',now(),NULL,'SYNC_ERROR'),
      ('${WS}','${CLIENT}','atera-two','ticket','OK',now() - interval '2 days',now() - interval '2 days',NULL),
      ('${WS}','${CLIENT}','demo-huntress-connection','incident','UNAVAILABLE',now(),NULL,'SOURCE_UNAVAILABLE');
    INSERT INTO "ResourceSnapshot" VALUES
      ('${WS}','${CLIENT}','demo-atera-connection','alert',now(),'[${item('alert', 'A-1', MARKERS.title)}]',1,false,'test'),
      ('${WS}','${CLIENT}','atera-two','ticket',now() - interval '2 days','[${item('ticket', 'T-1', MARKERS.title)}]',1,false,'test');`);
}

export interface AskDb { readonly pgdb: PgTestDatabase; readonly tech: string }
export async function askDatabase(): Promise<AskDb> {
  const pgdb = await createTestDatabase();
  const tech = generateToken();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: tech });
  await seedAsk(pgdb.owner);
  return { pgdb, tech };
}

/** A synthetic actor of `workspace` with one membership on `client` (or none) and a fresh token; owner writes bump the fence. */
export async function addActor(owner: pg.Client, id: string, permissions: string[] | null, options: { workspace?: string; client?: string; expiresAt?: string } = {}) {
  const workspace = options.workspace ?? WS; const client = options.client ?? CLIENT;
  const token = generateToken();
  await owner.query(`INSERT INTO "Actor" ("workspaceId",id,"displayName","workspacePermissions") VALUES ($1,$2,'Synthetic Ask actor',ARRAY[]::text[])`, [workspace, id]);
  if (permissions !== null) {
    await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [workspace, client, id, permissions]);
  }
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId",id,"actorId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,$5)`,
    [workspace, `token-${id}`, id, hashToken(token), options.expiresAt ?? null]);
  return token;
}
/** Another workspace with one client (owner writes; its fence row is created by the accepted Workspace trigger). */
export async function addWorkspace(owner: pg.Client, workspace: string, client: string): Promise<void> {
  await owner.query(`INSERT INTO "Workspace" (id,name) VALUES ($1,'Synthetic other workspace')`, [workspace]);
  await owner.query(`INSERT INTO "Client" ("workspaceId",id,name) VALUES ($1,$2,'Synthetic other client')`, [workspace, client]);
}
export const fenceVersion = async (owner: pg.Client, workspace = WS): Promise<number> =>
  Number((await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [workspace])).rows[0].version);
export const count = async (owner: pg.Client, table: string, where = 'true'): Promise<number> =>
  Number((await owner.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`)).rows[0].n);
/** Digest of a whole table's rows (business tables must not change). */
export const digest = async (owner: pg.Client, table: string): Promise<string> =>
  (await owner.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM "${table}" t`)).rows[0].d as string;
export const BUSINESS_TABLES = ['Observation', 'RawEvent', 'ResourceSnapshot', 'SyncState', 'Connection', 'Entity', 'Person', 'Device', 'EntityLink',
  'ExternalEntity', 'ClientMembership', 'ApiToken', 'Actor', 'ToolExecution', 'DecisionRun', 'ActionRequest'];

export const askBody = (question: string, observationId: string | null = null, requestId: string = randomUUID()) =>
  ({ contractVersion: 'AskRequestV1', requestId, question, observationId });
export interface AskResponse { status: number; headers: Headers; text: string; json: any }
export async function postAsk(base: string, token: string | null, clientId: string, body: unknown, init: RequestInit = {}): Promise<AskResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) };
  const response = await fetch(`${base}/clients/${encodeURIComponent(clientId)}/ask`, { method: 'POST', headers, body: JSON.stringify(body), ...init });
  const text = await response.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json };
}
export async function getCapability(base: string, token: string | null): Promise<AskResponse> {
  const response = await fetch(`${base}/ask/capabilities`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json };
}

/** One raw HTTP/1.1 exchange on a fresh socket; resolves with the whole response text (or the socket error code). */
export function rawHttp(port: number, request: string | Buffer, timeoutMs = 15_000): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw request timed out')); }, timeoutMs);
    socket.on('data', chunk => { data += String(chunk); });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(head?.split(' ')[1] ?? 0), head: head ?? '', body: rest.join('\r\n\r\n') });
    });
  });
}

/**
 * The DB API in this process, built from the compiled dist (npm run api:build), MOCK, with an optional in-process planner
 * (the private DI seam; never configuration) and the budget object the boundary uses, so tests observe owners directly.
 */
export interface InProcessApi { base: string; port: number; budget: any; close(): Promise<void> }
export async function inProcessApi(runtimeUrl: string, planner?: unknown): Promise<InProcessApi> {
  await import('reflect-metadata');
  const dist = (path: string) => import(join(projectRoot, 'dist', path));
  const [{ NestFactory }, { PrismaClient }, { AtlasDbModule }, { installApiParsers }, { AskBudget }] = await Promise.all([
    import('@nestjs/core'), import('@prisma/client'), dist('apps/api/src/db/app.module.js'), dist('apps/api/src/ask-http.js'), dist('packages/ask/budget.js')]);
  const db = new PrismaClient({ datasourceUrl: runtimeUrl });
  const budget = new AskBudget();
  const app = await NestFactory.create(AtlasDbModule.forDatabase(db, 'mock', planner), { logger: false, bodyParser: false });
  installApiParsers(app, 'mock', budget);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, port, budget, close: async () => { await app.close(); } };
}

/** The compiled API as a child process (cwd = project root) with its whole stdout/stderr kept for the log-privacy checks. */
export interface AskProcess { base: string; port: number; output(): string; stop(): Promise<void> }
export async function startAskProcess(env: Record<string, string>): Promise<AskProcess> {
  const { spawn } = await import('node:child_process');
  const { freePort } = await import('./api-process.ts');
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/apps/api/src/main.js'], { cwd: projectRoot, env: { ...process.env, ...env, ATLAS_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += String(d); }); child.stderr.on('data', d => { output += String(d); });
  const stop = () => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}: ${output.slice(-2000)}`);
    try { await fetch(`${base}/clients`, { headers: { Host: `127.0.0.1:${port}` } }); return { base, port, output: () => output, stop }; } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error('API did not become ready');
}
