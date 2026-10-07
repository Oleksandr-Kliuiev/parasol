import assert from 'node:assert/strict';
import { SET_SCOPE_SQL, RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../packages/graph/scope-context.ts';
import type { RuntimeRoleFacts } from '../packages/graph/scope-context.ts';

/**
 * SQL invariants shared by the PGlite test (tests/database.test.ts) and the real PostgreSQL 17 check
 * (scripts/pg17-check.ts). Same statements, two engines, so the report can state what each one verified.
 */
export interface SqlRunner {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
export const rejects = async (p: Promise<unknown>, pattern?: RegExp) => pattern ? assert.rejects(p, pattern) : assert.rejects(p);

/** Two clients in one workspace, the Gasta graph in c1, a decoy device in c2, confirmed links to both sources. Owner only. */
export async function seedGraph(owner: SqlRunner): Promise<void> {
  await owner.exec(`
    INSERT INTO "Workspace" VALUES ('w','Demo'),('w2','Other workspace');
    INSERT INTO "Client" VALUES ('w','c1','Client 1'),('w','c2','Client 2'),('w2','cx','Foreign');
    INSERT INTO "Entity" VALUES ('w','c1','p1','PERSON'),('w','c1','d1','DEVICE'),('w','c1','d2','DEVICE'),('w','c2','d9','DEVICE');
    INSERT INTO "Person" VALUES ('w','c1','p1','Kari synthetic','kari@example.invalid');
    INSERT INTO "Device" VALUES ('w','c1','d1','GASTA-LT-07','p1'),('w','c2','d9','OTHER-PC',NULL);
    INSERT INTO "Connection" VALUES ('w','c1','a','atera','atera-demo','fixture://none','FIXTURE'),('w','c1','h','huntress','huntress-demo','fixture://none','FIXTURE'),('w','c2','a2','atera','atera-other','fixture://none','FIXTURE');
    INSERT INTO "ExternalEntity" VALUES ('w','c1','ea','a','agent','atera-107','{}',now()),('w','c1','eh','h','agent','huntress-207','{}',now());
    INSERT INTO "EntityLink" VALUES ('w','c1','l1','d1','ea','CONFIRMED','FIXTURE',1,'seed',now()),('w','c1','l2','d1','eh','CONFIRMED','FIXTURE',1,'seed',now());
  `);
}

const rawEvent = (ws: string, c: string, id: string, conn: string, type: string, ext: string, rev: string, key: string, hash = 'p', conflictOf: string | null = null) =>
  `INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","conflictOfEventKey")
   VALUES ('${ws}','${c}','${id}','${conn}','${type}','${ext}','${rev}','${key}','{"kind":"DISK_CAPACITY","summary":"s"}','${hash}',now(),${conflictOf === null ? 'NULL' : `'${conflictOf}'`})`;
const decisionRun = (c: string, id: string, eventId: string, applied: boolean) =>
  `INSERT INTO "DecisionRun" ("workspaceId","clientId","id","eventId","provider","mode","applied","promptVersion","inputHash","status")
   VALUES ('w','${c}','${id}','${eventId}','rules','rules',${applied},'v1','h','OK')`;
const observation = (c: string, id: string, eventId: string, severity: string, rank: number, priority: string, entityId: string | null, runId: string | null, createdAt = 'now()') =>
  `INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","decisionRunId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt")
   VALUES ('w','${c}','${id}','${eventId}',${entityId === null ? 'NULL' : `'${entityId}'`},${runId === null ? 'NULL' : `'${runId}'`},'OPERATIONS','${severity}',${rank},'${priority}','HUMAN_REVIEW',1,'rules','v1',ARRAY['RULES_BASELINE'],${createdAt})`;

/** Structural invariants, run as the owner (RLS bypassed by design). */
export async function checkStructuralInvariants(owner: SqlRunner): Promise<void> {
  const graph = await owner.query<{ hostname: string }>(`SELECT d.hostname FROM "Device" d JOIN "EntityLink" l ON l."workspaceId"=d."workspaceId" AND l."clientId"=d."clientId" AND l."entityId"=d.id WHERE d.id='d1'`);
  assert.equal(graph.length, 2);
  // Scoping and links
  await rejects(owner.exec(`INSERT INTO "Device" VALUES ('w','c2','d1','Wrong scope','p1')`));
  await rejects(owner.exec(`INSERT INTO "EntityLink" VALUES ('w','c1','l3','d2','ea','CONFIRMED','FIXTURE',1,'seed',now())`));
  // Event identity: resource type is part of it; a second canonical row for the same identity is rejected; same id with another type is a different event
  await owner.exec(rawEvent('w', 'c1', 'r1', 'a', 'alert', '123', '1', 'k1', 'p1'));
  await rejects(owner.exec(rawEvent('w', 'c1', 'r2', 'a', 'alert', '123', '1', 'k2', 'p1')));
  await rejects(owner.exec(rawEvent('w', 'c1', 'r2b', 'a', 'alert', '123', '1', 'k2b', 'p9')), undefined); // different content but no conflict link: still not a second canonical
  await owner.exec(rawEvent('w', 'c1', 'r3', 'a', 'ticket', '123', '1', 'k3', 'p1'));
  await owner.exec(rawEvent('w', 'c2', 'r9', 'a2', 'alert', '900', '1', 'k9', 'p1'));
  // Conflicting redelivery: same identity, different content, linked to the canonical row; identical conflict content is a duplicate
  await owner.exec(rawEvent('w', 'c1', 'r1c', 'a', 'alert', '123', '1', 'k1c', 'p2', 'k1'));
  await rejects(owner.exec(rawEvent('w', 'c1', 'r1c2', 'a', 'alert', '123', '1', 'k1c2', 'p2', 'k1')));
  await rejects(owner.exec(rawEvent('w', 'c1', 'r1x', 'a', 'alert', '124', '1', 'k1x', 'p1', 'k1x')), /conflict_self|violates/);
  await rejects(owner.exec(rawEvent('w', 'c1', 'r1y', 'a', 'alert', '125', '1', 'k1y', 'p1', 'no-such-key')));
  // S1: the conflict link is scoped and identity-bound, and its parent must be canonical
  await rejects(owner.exec(rawEvent('w', 'c1', 'r-x-client', 'a', 'alert', '900', '1', 'k-x-client', 'p3', 'k9')), /foreign key/);      // parent k9 belongs to client c2
  await rejects(owner.exec(rawEvent('w', 'c1', 'r-x-ident', 'a', 'alert', '777', '1', 'k-x-ident', 'p3', 'k1')), /foreign key/);        // same scope, different identity
  await rejects(owner.exec(rawEvent('w', 'c1', 'r-x-type', 'a', 'ticket', '123', '1', 'k-x-type', 'p3', 'k1')), /foreign key/);         // same id, other resource type
  await rejects(owner.exec(rawEvent('w', 'c1', 'r-x-chain', 'a', 'alert', '123', '1', 'k-x-chain', 'p4', 'k1c')), /canonical/);        // parent is itself a conflict row
  await owner.exec(rawEvent('w', 'c1', 'r1c3', 'a', 'alert', '123', '1', 'k1c3', 'p5', 'k1'));                                           // same scope + identity + canonical parent: accepted
  await rejects(owner.exec(`UPDATE "RawEvent" SET status='WHATEVER' WHERE id='r1'`));
  // Audit logs are append-only
  await owner.exec(`INSERT INTO "AuditEvent" VALUES ('w','c1','au1','actor','test','corr','{}',now())`);
  await rejects(owner.exec(`UPDATE "AuditEvent" SET "eventType"='changed'`), /append-only/);
  await rejects(owner.exec(`DELETE FROM "AuditEvent"`), /append-only/);
  await rejects(owner.exec(`TRUNCATE "AuditEvent"`), /append-only/);
  await owner.exec(`INSERT INTO "SecurityAuditEvent" ("workspaceId","id","actorId","eventType","requestedClientId","reasonCode","correlationId","metadata") VALUES ('w','s1','actor','tool.scope_denied','ghost-client','SCOPE_DENIED','corr','{}')`);
  await rejects(owner.exec(`UPDATE "SecurityAuditEvent" SET "reasonCode"='x'`), /append-only/);
  await rejects(owner.exec(`DELETE FROM "SecurityAuditEvent"`), /append-only/);
  // Approval contract
  await owner.exec(`INSERT INTO "Approval" VALUES ('w','c1','ap1','actor','atera.ticket.create','v1','{}','hash',1,'PENDING',NULL,NULL,now()+interval '1 hour',NULL)`);
  await rejects(owner.exec(`UPDATE "Approval" SET "canonicalInput"='{"changed":true}'`), /immutable/);
  await owner.exec(`UPDATE "Approval" SET status='REJECTED' WHERE id='ap1'`);
  // Decision runs: one applied per event; the applied run of an observation must belong to the same event
  await owner.exec(decisionRun('c1', 'run1', 'r1', true));
  await owner.exec(decisionRun('c1', 'run1-shadow', 'r1', false));
  await rejects(owner.exec(decisionRun('c1', 'run1-dup', 'r1', true)));
  await owner.exec(decisionRun('c1', 'run3', 'r3', true));
  await rejects(owner.exec(observation('c1', 'o-bad-run', 'r1', 'MEDIUM', 2, 'NORMAL', 'd1', 'run3')), undefined);
  // The referenced run must be the applied one; a referenced run cannot be un-applied afterwards
  await rejects(owner.exec(observation('c1', 'o-shadow-ref', 'r1', 'MEDIUM', 2, 'NORMAL', 'd1', 'run1-shadow')), undefined);
  // Observation consistency: rank must match severity; HIGH/CRITICAL must be URGENT; entity must be in the same client
  await rejects(owner.exec(observation('c1', 'o-bad-rank', 'r1', 'CRITICAL', 0, 'URGENT', 'd1', 'run1')));
  await rejects(owner.exec(observation('c1', 'o-bad-floor', 'r1', 'CRITICAL', 4, 'NORMAL', 'd1', 'run1')));
  await rejects(owner.exec(observation('c1', 'o-bad-entity', 'r1', 'MEDIUM', 2, 'NORMAL', 'd9', 'run1')));
  await owner.exec(observation('c1', 'o-r1', 'r1', 'CRITICAL', 4, 'URGENT', 'd1', 'run1', `now() - interval '10 days'`));
  await owner.exec(observation('c1', 'o-r3', 'r3', 'MEDIUM', 2, 'NORMAL', 'd1', 'run3'));
  await owner.exec(observation('c2', 'o-r9', 'r9', 'LOW', 1, 'NORMAL', 'd9', null));
  await rejects(owner.exec(`UPDATE "DecisionRun" SET applied=false WHERE id='run1'`), undefined); // referenced applied run is pinned
  await rejects(owner.exec(`UPDATE "Observation" SET status='RESOLVED' WHERE id='o-r3'`), undefined); // resolution needs resolvedAt/resolvedBy
  // S3: legacyClosure cannot be set by anyone after the migration, not even together with a closed status
  await rejects(owner.exec(`UPDATE "Observation" SET "legacyClosure"=true WHERE id='o-r3'`), /legacyClosure/);
  await rejects(owner.exec(`UPDATE "Observation" SET status='RESOLVED', "legacyClosure"=true WHERE id='o-r3'`), /legacyClosure/);
  await rejects(owner.exec(observation('c1', 'o-legacy-insert', 'r3', 'MEDIUM', 2, 'NORMAL', 'd1', 'run3').replace(`'OPERATIONS'`, `'OPERATIONS'`).replace(`"reasonCodes","createdAt")`, `"reasonCodes","createdAt","legacyClosure","status")`).replace(`ARRAY['RULES_BASELINE'],now())`, `ARRAY['RULES_BASELINE'],now(),true,'RESOLVED')`)), /legacyClosure/);
  await owner.exec(`UPDATE "Observation" SET status='RESOLVED', "resolvedAt"=now(), "resolvedBy"='tech' WHERE id='o-r3'`);
  await owner.exec(`UPDATE "Observation" SET status='OPEN', "resolvedAt"=NULL, "resolvedBy"=NULL WHERE id='o-r3'`);
  // Priority ordering: an older CRITICAL is returned before a newer MEDIUM; counts cover the whole set
  const ordered = await owner.query<{ id: string }>(`SELECT id FROM "Observation" WHERE "workspaceId"='w' AND "clientId"='c1' AND status='OPEN' ORDER BY "severityRank" DESC, "createdAt" DESC, id LIMIT 1`);
  assert.equal(ordered[0]?.id, 'o-r1');
  const counts = await owner.query<{ severity: string; n: number }>(`SELECT severity, count(*)::int AS n FROM "Observation" WHERE "workspaceId"='w' AND "clientId"='c1' AND status='OPEN' GROUP BY severity`);
  assert.deepEqual(Object.fromEntries(counts.map(c => [c.severity, c.n])), { CRITICAL: 1, MEDIUM: 1 });
}

/**
 * RLS acceptance, run through a CONFINED runner (role without BYPASSRLS that does not own the tables).
 * Checks, in the order of the v1.1 acceptance list: no context → denied; clients of one workspace isolated;
 * context does not survive the transaction (connection reuse); query without `where clientId` still limited;
 * wrong workspace → nothing; writes without context rejected.
 */
export async function checkRlsInvariants(app: SqlRunner, options: { label: string }): Promise<void> {
  const facts = await app.query<RuntimeRoleFacts>(RUNTIME_ROLE_CHECK_SQL);
  assertConfinedRuntimeRole(facts[0]);
  const count = async (sql: string) => Number((await app.query<{ n: number }>(sql))[0]?.n ?? 0);
  // 1. No access context → every client-scoped table is empty and writes are rejected
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Observation"`), 0, `${options.label}: no context must deny reads`);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Client"`), 0);
  await rejects(app.exec(`INSERT INTO "AuditEvent" VALUES ('w','c1','au-rls','actor','test','corr','{}',now())`), /row-level security/);
  // 2. Clients of one workspace are isolated; 4. a query without `where clientId` is still limited to the allowed client
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c1']);
  const visible = await app.query<{ clientId: string }>(`SELECT DISTINCT "clientId" FROM "Observation"`);
  assert.deepEqual(visible.map(v => v.clientId), ['c1'], `${options.label}: only the allowed client is visible without a where clause`);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Observation" WHERE "clientId"='c2'`), 0, 'explicit other-client filter yields nothing');
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Client"`), 1);
  await app.exec('SAVEPOINT denied_write');
  await rejects(app.exec(`INSERT INTO "AuditEvent" VALUES ('w','c2','au-rls2','actor','test','corr','{}',now())`), /row-level security/);
  await app.exec('ROLLBACK TO SAVEPOINT denied_write');
  // S1 under the runtime role: the parent of another client is invisible AND the scoped FK rejects the link
  assert.equal(await count(`SELECT count(*)::int AS n FROM "RawEvent" WHERE "eventKey"='k9'`), 0, 'parent of client c2 is not visible to c1');
  await app.exec('SAVEPOINT cross_client_conflict');
  await rejects(app.exec(rawEvent('w', 'c1', 'r-rls-x', 'a', 'alert', '900', '1', 'k-rls-x', 'p3', 'k9')), /foreign key/);
  await app.exec('ROLLBACK TO SAVEPOINT cross_client_conflict');
  await app.exec(`INSERT INTO "AuditEvent" VALUES ('w','c1','au-rls3','actor','test','corr','{}',now())`);
  await app.exec('COMMIT');
  // 3. Context does not survive the transaction: the same connection sees nothing afterwards
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Observation"`), 0, `${options.label}: context must not leak past COMMIT`);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "AuditEvent"`), 0);
  // 5. Wrong workspace, or a client list from another workspace, yields nothing
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w2', 'c1']);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Observation"`), 0);
  await app.exec('ROLLBACK');
  // Multi-client membership sees exactly those clients
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c1,c2']);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "Client"`), 2);
  await app.exec('ROLLBACK');
  // Workspace-level security audit follows the workspace only
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c2']);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "SecurityAuditEvent"`), 1);
  await app.exec('ROLLBACK');
}

/**
 * The runtime-role guard must reject a role that owns ANY protected table (not only Observation) and must notice a
 * protected table whose RLS was disabled. `owner` reconfigures the database; `app` runs the check as the confined role.
 */
export async function checkRuntimeRoleGuard(owner: SqlRunner, app: SqlRunner, appRole: string, options: { reconnectApp?: () => Promise<void> }): Promise<void> {
  const facts = async () => (await app.query<RuntimeRoleFacts>(RUNTIME_ROLE_CHECK_SQL))[0];
  assert.throws(() => assertConfinedRuntimeRole(undefined), /RUNTIME_ROLE_BYPASSES_RLS/);
  assertConfinedRuntimeRole(await facts());
  // Ownership of one table other than Observation (the v1.1.0 guard looked at Observation only)
  await owner.exec(`ALTER TABLE "RawEvent" OWNER TO "${appRole}"`);
  if (options.reconnectApp) await options.reconnectApp();
  const owning = await facts();
  assert.equal(owning.ownsProtectedTables, true);
  assert.throws(() => assertConfinedRuntimeRole(owning), /RUNTIME_ROLE_BYPASSES_RLS/);
  // ... and that configuration really would leak: the owner of RawEvent reads it without any scope
  const leaked = Number((await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM "RawEvent"`))[0]?.n ?? 0);
  assert.ok(leaked > 0, 'table owner bypasses RLS — exactly what the guard must catch');
  await owner.exec(`ALTER TABLE "RawEvent" OWNER TO CURRENT_USER`);
  if (options.reconnectApp) await options.reconnectApp();
  assertConfinedRuntimeRole(await facts());
  // A protected table with RLS disabled is reported, even for a correctly confined role
  await owner.exec(`ALTER TABLE "Approval" DISABLE ROW LEVEL SECURITY`);
  const unprotected = await facts();
  assert.equal(Number(unprotected.unprotectedTables), 1);
  assert.throws(() => assertConfinedRuntimeRole(unprotected), /RLS_NOT_ENABLED/);
  await owner.exec(`ALTER TABLE "Approval" ENABLE ROW LEVEL SECURITY`);
  assertConfinedRuntimeRole(await facts());
}
