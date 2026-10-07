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
export const rejects = async (p: Promise<unknown>, pattern?: RegExp, message?: string) => pattern ? assert.rejects(p, pattern, message) : assert.rejects(p, message);

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
    INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","status","method","confidence","confirmedBy","confirmedAt") VALUES ('w','c1','l1','d1','ea','agent','DEVICE','CONFIRMED','FIXTURE',1,'seed',now()),('w','c1','l2','d1','eh','agent','DEVICE','CONFIRMED','FIXTURE',1,'seed',now());
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
  await rejects(owner.exec(`INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","status","method","confidence","confirmedBy","confirmedAt") VALUES ('w','c1','l3','d2','ea','agent','DEVICE','CONFIRMED','FIXTURE',1,'seed',now())`), /one_confirmed_external/);
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

// ---------------------------------------------------------------------------------------------------------------------
// Identities (migration 202610071600): actors, per-client memberships and API token digests
// ---------------------------------------------------------------------------------------------------------------------
const DIGEST_1 = '1'.repeat(64); const DIGEST_2 = '2'.repeat(64);

/** Two actors of workspace w with one membership each; one token digest each. Owner only; needs seedGraph first. */
export async function seedIdentities(owner: SqlRunner): Promise<void> {
  await owner.exec(`
    INSERT INTO "Actor" ("workspaceId","id","displayName","workspacePermissions") VALUES ('w','tech','Technician',ARRAY['security_audit:read']),('w','other','Other technician',ARRAY[]::text[]);
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c1','tech',ARRAY['context:read']),('w','c2','other',ARRAY['context:read']);
    INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash") VALUES ('w','t1','tech','${DIGEST_1}'),('w','t2','other','${DIGEST_2}');`);
}

/** Structural rules, as the owner: explicit vocabularies, digests only, and every link carries the workspace. */
export async function checkIdentityStructure(owner: SqlRunner): Promise<void> {
  await rejects(owner.exec(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash") VALUES ('w','plain','tech','a-bearer-secret-in-plain-text')`), /tokenHash_check/);
  await rejects(owner.exec(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c2','tech',ARRAY['tickets:write'])`), /permissions_check/);
  await rejects(owner.exec(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c2','tech',ARRAY[NULL]::text[])`), /permissions_check/);
  await rejects(owner.exec(`UPDATE "Actor" SET "workspacePermissions" = ARRAY['god_mode'] WHERE id = 'tech'`), /workspacePermissions_check/);
  await rejects(owner.exec(`UPDATE "Actor" SET status = 'SUSPENDED' WHERE id = 'tech'`), /status_check/);
  // An actor of workspace w cannot become a member of client cx of workspace w2, under either workspace
  await rejects(owner.exec(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId") VALUES ('w2','cx','tech')`), /foreign key/);
  await rejects(owner.exec(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId") VALUES ('w','cx','tech')`), /foreign key/);
  await rejects(owner.exec(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash") VALUES ('w2','t9','tech','${'9'.repeat(64)}')`), /foreign key/);
  // Mapping permissions (migration 202610071700) belong to the vocabulary
  await owner.exec(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read','mapping:review','connections:manage','observations:triage'] WHERE "actorId" = 'tech'`);
  await rejects(owner.exec(`UPDATE "ClientMembership" SET permissions = ARRAY['observations:delete'] WHERE "actorId" = 'tech'`), /permissions_check/);
  await owner.exec(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "actorId" = 'tech'`);
}

/**
 * Authentication lookup under RLS, through a CONFINED runner: a token row only for its own digest, an actor and its
 * memberships only when named inside the workspace, nothing under an ordinary client scope, and no identity writes
 * whatever context the role sets. `owner` verifies afterwards that the attempted writes changed nothing.
 */
export async function checkIdentityRlsInvariants(owner: SqlRunner, app: SqlRunner, options: { label: string }): Promise<void> {
  const n = async (r: SqlRunner, sql: string) => Number((await r.query<{ n: number }>(sql))[0]?.n ?? 0);
  const tables = ['Actor', 'ClientMembership', 'ApiToken'];
  for (const t of tables) assert.equal(await n(app, `SELECT count(*)::int AS n FROM "${t}"`), 0, `${options.label}: ${t} without context`);
  await app.exec('BEGIN');
  await app.query(`SELECT set_config('app.token_hash', $1, true)`, [DIGEST_1]);
  assert.deepEqual((await app.query<{ id: string }>(`SELECT id FROM "ApiToken"`)).map(r => r.id), ['t1'], 'only the token with this digest');
  assert.equal(await n(app, `SELECT count(*)::int AS n FROM "Actor"`), 0, 'a digest alone names no actor');
  await app.exec('COMMIT');
  assert.equal(await n(app, `SELECT count(*)::int AS n FROM "ApiToken"`), 0, 'the lookup context ends with the transaction');
  await app.exec('BEGIN');
  await app.query(`SELECT set_config('app.workspace_id', 'w', true), set_config('app.actor_id', 'tech', true)`);
  assert.deepEqual((await app.query<{ id: string }>(`SELECT id FROM "Actor"`)).map(r => r.id), ['tech']);
  assert.deepEqual((await app.query<{ clientId: string; actorId: string }>(`SELECT "clientId", "actorId" FROM "ClientMembership"`)).map(r => `${r.actorId}@${r.clientId}`), ['tech@c1']);
  assert.equal(await n(app, `SELECT count(*)::int AS n FROM "ApiToken"`), 0, 'naming an actor does not expose its tokens');
  await app.exec('ROLLBACK');
  await app.exec('BEGIN');
  await app.query(`SELECT set_config('app.workspace_id', 'w2', true), set_config('app.actor_id', 'tech', true)`);
  assert.equal(await n(app, `SELECT count(*)::int AS n FROM "Actor"`), 0, 'the same actor id in another workspace');
  await app.exec('ROLLBACK');
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c1,c2']);
  for (const t of tables) assert.equal(await n(app, `SELECT count(*)::int AS n FROM "${t}"`), 0, `${t} under an ordinary client scope`);
  await app.exec('ROLLBACK');
  // Writes: rejected by RLS (no write policy) or by the missing grant (roles.sql), or they touch no row. Never effective.
  const attempt = async (sql: string) => { try { await app.exec(sql); } catch { await app.exec('ROLLBACK').catch(() => undefined); } };
  await attempt(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash") VALUES ('w','t-rogue','tech','${'3'.repeat(64)}')`);
  await attempt(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c2','tech',ARRAY['context:read'])`);
  await attempt(`BEGIN; SELECT set_config('app.workspace_id', 'w', true), set_config('app.actor_id', 'tech', true);
    UPDATE "ClientMembership" SET permissions = ARRAY['context:read','events:ingest']; UPDATE "Actor" SET status = 'DISABLED'; COMMIT;`);
  await attempt(`BEGIN; SELECT set_config('app.token_hash', '${DIGEST_2}', true); UPDATE "ApiToken" SET "actorId" = 'tech'; COMMIT;`);
  const rows = async (sql: string) => (await owner.query<{ s: string }>(sql)).map(r => r.s);
  assert.deepEqual(await rows(`SELECT "actorId"||'@'||"clientId"||':'||array_to_string(permissions, '+') AS s FROM "ClientMembership" ORDER BY 1`), ['other@c2:context:read', 'tech@c1:context:read']);
  assert.deepEqual(await rows(`SELECT id||':'||"actorId" AS s FROM "ApiToken" ORDER BY 1`), ['t1:tech', 't2:other']);
  assert.deepEqual(await rows(`SELECT id||':'||status AS s FROM "Actor" ORDER BY 1`), ['other:ACTIVE', 'tech:ACTIVE']);
}

// ---------------------------------------------------------------------------------------------------------------------
// Mapping workflow (migration 202610071700): typed links, quarantine, explicit connection binding. Owner, after seedGraph.
// ---------------------------------------------------------------------------------------------------------------------
const link = (id: string, entity: string, external: string, type: string, kind: string, extra = '', extraValues = '') =>
  `INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","method"${extra})
   VALUES ('w','c1','${id}','${entity}','${external}','${type}','${kind}','MANUAL'${extraValues})`;

export async function checkMappingStructure(owner: SqlRunner): Promise<void> {
  await owner.exec(`INSERT INTO "ExternalEntity" VALUES ('w','c1','ec','a','contact','atera-contact-5','{}',now())`);
  // Typed links: only agent-DEVICE and contact-PERSON, and the claimed types must be the real ones of both rows
  await rejects(owner.exec(link('t-bad-pair', 'p1', 'ea', 'agent', 'PERSON')), /type_compat_check|foreign key/);
  await rejects(owner.exec(link('t-lie-ext', 'p1', 'ea', 'contact', 'PERSON')), /external_typed_fkey/);
  await rejects(owner.exec(link('t-lie-kind', 'd2', 'ec', 'contact', 'PERSON')), /entity_typed_fkey/);
  await owner.exec(link('t-contact', 'p1', 'ec', 'contact', 'PERSON'));
  // A linked entity cannot change kind, a linked external object cannot change resource type underneath the link
  await rejects(owner.exec(`UPDATE "Entity" SET kind = 'PERSON' WHERE id = 'd1'`), /foreign key/);
  await rejects(owner.exec(`UPDATE "ExternalEntity" SET "resourceType" = 'contact' WHERE id = 'ea'`), /foreign key/);
  // Quarantine: decided by someone, for a reason; a conflict names a link of the SAME external entity, never itself
  await rejects(owner.exec(link('q-bare', 'd2', 'ea', 'agent', 'DEVICE', ',"status"', ",'QUARANTINED'")), /quarantine_check/);
  await rejects(owner.exec(link('q-no-target', 'd2', 'ea', 'agent', 'DEVICE', ',"status","reviewedBy","reviewedAt","reasonCode"',
    ",'QUARANTINED','tech',now(),'CONFLICTS_WITH_CONFIRMED'")), /quarantine_check/);
  await rejects(owner.exec(link('q-other-ext', 'd2', 'ea', 'agent', 'DEVICE', ',"status","reviewedBy","reviewedAt","reasonCode","conflictsWithLinkId"',
    ",'QUARANTINED','tech',now(),'CONFLICTS_WITH_CONFIRMED','l2'")), /conflictsWith_fkey/);
  await rejects(owner.exec(link('q-self', 'd2', 'ea', 'agent', 'DEVICE', ',"status","reviewedBy","reviewedAt","reasonCode","conflictsWithLinkId"',
    ",'QUARANTINED','tech',now(),'CONFLICTS_WITH_CONFIRMED','q-self'")), /conflict_self_check|conflictsWith_fkey/);
  await rejects(owner.exec(link('q-free-text', 'd2', 'ea', 'agent', 'DEVICE', ',"reasonCode"', ",'customer said so'")), /reason_code_check/);
  await owner.exec(link('q-ok', 'd2', 'ea', 'agent', 'DEVICE', ',"status","reviewedBy","reviewedAt","reasonCode","conflictsWithLinkId"',
    ",'QUARANTINED','tech',now(),'CONFLICTS_WITH_CONFIRMED','l1'"));
  await rejects(owner.exec(`UPDATE "EntityLink" SET status = 'CONFIRMED', "confirmedBy" = 'tech', "confirmedAt" = now() WHERE id = 'q-ok'`), /one_confirmed_external/);
  // Connection: status vocabulary, provenance for live bindings, immutable tenant
  await rejects(owner.exec(`UPDATE "Connection" SET status = 'LIVE' WHERE id = 'a'`), /Connection_status_check/);
  await rejects(owner.exec(`UPDATE "Connection" SET status = 'ACTIVE' WHERE id = 'a'`), /live_binding_check/);
  await owner.exec(`UPDATE "Connection" SET status = 'ACTIVE', "boundBy" = 'admin', "boundAt" = now() WHERE id = 'a'`);
  await rejects(owner.exec(`UPDATE "Connection" SET "externalTenantId" = 'atera-someone-else' WHERE id = 'a'`), /binding is immutable/);
  await rejects(owner.exec(`UPDATE "Connection" SET "boundBy" = 'someone-else' WHERE id = 'a'`), /provenance is immutable/);
  await rejects(owner.exec(`INSERT INTO "Connection" VALUES ('w','c2','a-dup','atera','atera-demo','fixture://none','DISABLED')`), /duplicate key/);
  await owner.exec(`UPDATE "Connection" SET status = 'DISABLED' WHERE id = 'a'`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshots (migration 202610071800): bounded items, success after attempt, codes for failures, client isolation
// ---------------------------------------------------------------------------------------------------------------------
const snapshot = (client: string, connection: string, type: string, items: string, count: number, truncated: boolean) =>
  `INSERT INTO "ResourceSnapshot" VALUES ('w','${client}','${connection}','${type}',now(),'${items}',${count},${truncated},'test')`;

/** Owner, after seedGraph. */
export async function checkSnapshotStructure(owner: SqlRunner): Promise<void> {
  await owner.exec(`INSERT INTO "SyncState" ("workspaceId","clientId","connectionId","resourceType","status","lastSyncAt","lastSuccessAt")
    VALUES ('w','c1','h','incident','OK',now(),now()), ('w','c2','a2','ticket','OK',now(),now())`);
  await owner.exec(snapshot('c1', 'h', 'incident', '[]', 0, false));
  await owner.exec(snapshot('c2', 'a2', 'ticket', '[{"externalId":"t1"}]', 1, false));
  await rejects(owner.exec(snapshot('c1', 'a', 'alert', '[]', 0, false)), /foreign key/, 'a snapshot needs the sync state of the same connection and resource');
  await rejects(owner.exec(`UPDATE "ResourceSnapshot" SET "itemCount" = 5 WHERE "clientId" = 'c1'`), /items_check/, 'more in the source than stored means truncated');
  await rejects(owner.exec(`UPDATE "ResourceSnapshot" SET items = (SELECT jsonb_agg(g) FROM generate_series(1, 101) g), "itemCount" = 101 WHERE "clientId" = 'c1'`), /items_check/);
  await rejects(owner.exec(`UPDATE "ResourceSnapshot" SET items = '{}' WHERE "clientId" = 'c1'`), /items_check/);
  await rejects(owner.exec(`INSERT INTO "SyncState" ("workspaceId","clientId","connectionId","resourceType","status","lastSyncAt") VALUES ('w','c1','h','agent','ERROR',now())`), /error_code_check/);
  await rejects(owner.exec(`UPDATE "SyncState" SET "lastSuccessAt" = "lastSyncAt" + interval '1 minute' WHERE "clientId" = 'c1'`), /success_order_check/);
  await rejects(owner.exec(`UPDATE "SyncState" SET status = 'PARTIAL', "safeErrorCode" = 'X' WHERE "clientId" = 'c1'`), /status_check/);
  // Attempt order (migration 202610072000, review B3): the recorded attempt is one that was begun
  await owner.exec(`UPDATE "SyncState" SET "attemptSeq" = 2, "recordedSeq" = 2 WHERE "clientId" = 'c1'`);
  await rejects(owner.exec(`UPDATE "SyncState" SET "recordedSeq" = 3 WHERE "clientId" = 'c1'`), /attempt_order_check/);
  await rejects(owner.exec(`UPDATE "SyncState" SET "recordedSeq" = -1 WHERE "clientId" = 'c1'`), /attempt_order_check/);
  // PENDING (migration 202610072100): a first attempt began and nothing is recorded yet — no times, no code, no recorded number
  await owner.exec(`INSERT INTO "SyncState" ("workspaceId","clientId","connectionId","resourceType","status","attemptSeq") VALUES ('w','c1','h','agent','PENDING',1)`);
  const pending = `WHERE "clientId" = 'c1' AND "resourceType" = 'agent'`;
  await rejects(owner.exec(`UPDATE "SyncState" SET "lastSyncAt" = now() ${pending}`), /pending_check/, 'PENDING has no outcome time');
  await rejects(owner.exec(`UPDATE "SyncState" SET "safeErrorCode" = 'X' ${pending}`), /pending_check/);
  await rejects(owner.exec(`UPDATE "SyncState" SET "recordedSeq" = 1 ${pending}`), /pending_check/);
}

/** Confined runner: snapshots follow the client scope like every other client table. */
export async function checkSnapshotRls(app: SqlRunner): Promise<void> {
  assert.equal(Number((await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ResourceSnapshot"`))[0]?.n ?? 0), 0, 'no context: no snapshot');
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c1']);
  assert.deepEqual((await app.query<{ clientId: string }>(`SELECT "clientId" FROM "ResourceSnapshot"`)).map(r => r.clientId), ['c1']);
  await app.exec('ROLLBACK');
}

// ---------------------------------------------------------------------------------------------------------------------
// Durable inbox (migrations 202610071900, 202610072000): leases with their claim token, finished events, failure codes,
// decision vocabularies. Owner, after checkStructuralInvariants.
// ---------------------------------------------------------------------------------------------------------------------
export async function checkInboxStructure(owner: SqlRunner): Promise<void> {
  await rejects(owner.exec(`UPDATE "RawEvent" SET "leaseOwner" = 'w1' WHERE id = 'r3'`), /RawEvent_lease_check/, 'a lease names its owner, its expiry and its token');
  await rejects(owner.exec(`UPDATE "RawEvent" SET "leaseOwner" = 'w1', "leaseExpiresAt" = now() + interval '1 minute' WHERE id = 'r3'`), /RawEvent_lease_check/,
    'no lease without a claim token (review B1)');
  await rejects(owner.exec(`UPDATE "RawEvent" SET "claimToken" = gen_random_uuid() WHERE id = 'r3'`), /RawEvent_lease_check/, 'no claim token without a lease');
  await owner.exec(`UPDATE "RawEvent" SET "leaseOwner" = 'w1', "leaseExpiresAt" = now() + interval '1 minute', "claimToken" = gen_random_uuid() WHERE id = 'r3'`);
  await rejects(owner.exec(`UPDATE "RawEvent" SET status = 'PROCESSED' WHERE id = 'r3'`), /finished_without_lease_check/);
  await owner.exec(`UPDATE "RawEvent" SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "claimToken" = NULL WHERE id = 'r3'`);
  await rejects(owner.exec(`UPDATE "RawEvent" SET status = 'DEAD_LETTER' WHERE id = 'r3'`), /RawEvent_error_code_check/, 'a dead letter says why');
  await rejects(owner.exec(`UPDATE "RawEvent" SET "preparedDecision" = '[1]' WHERE id = 'r3'`), /prepared_decision_check/);
  await rejects(owner.exec(`INSERT INTO "DecisionRun" ("workspaceId","clientId","id","eventId","provider","mode","applied","promptVersion","inputHash","status","safeErrorCode")
    VALUES ('w','c1','run-x','r3','rules','rules',false,'v1','h','UNKNOWN','X')`), /DecisionRun_status_check/);
  await rejects(owner.exec(`INSERT INTO "DecisionRun" ("workspaceId","clientId","id","eventId","provider","mode","applied","promptVersion","inputHash","status")
    VALUES ('w','c1','run-y','r3','gpt','rules',false,'v1','h','OK')`), /DecisionRun_provider_check/);
  await rejects(owner.exec(`INSERT INTO "DecisionRun" ("workspaceId","clientId","id","eventId","provider","mode","applied","promptVersion","inputHash","status")
    VALUES ('w','c1','run-z','r3','openai','advisory',false,'v1','h','FAILED')`), /DecisionRun_failure_code_check/, 'a failed run says why');
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

// ---------------------------------------------------------------------------------------------------------------------
// Decision layer (migration 202610072200): DecisionRun config version and measurements; ShadowJob vocabulary, leases,
// finished jobs and its scope-carrying link to the event. Owner, after checkStructuralInvariants (events r1, r3 in c1; r9 in c2).
// ---------------------------------------------------------------------------------------------------------------------
const shadowJob = (c: string, eventId: string, extra = '', values = '') =>
  `INSERT INTO "ShadowJob" ("workspaceId","clientId","eventId","configVersion"${extra}) VALUES ('w','${c}','${eventId}','decisions-test.1'${values})`;
export async function checkDecisionLayerStructure(owner: SqlRunner): Promise<void> {
  await rejects(owner.exec(`UPDATE "DecisionRun" SET "configVersion" = 'Decisions V1' WHERE id = 'run3'`), /config_version_check/);
  await owner.exec(`UPDATE "DecisionRun" SET "configVersion" = 'decisions-2026-10-07.1-env', "inputTokens" = 42, "latencyMs" = 120 WHERE id = 'run3'`);
  await rejects(owner.exec(`UPDATE "DecisionRun" SET "inputTokens" = -1 WHERE id = 'run3'`), /measures_check/);
  await rejects(owner.exec(`UPDATE "DecisionRun" SET "latencyMs" = -5 WHERE id = 'run3'`), /measures_check/);
  await owner.exec(shadowJob('c1', 'r1'));
  await rejects(owner.exec(shadowJob('c2', 'r1')), /foreign key/, 'a job belongs to an event of its own client');
  await rejects(owner.exec(shadowJob('c1', 'r1')), /pkey|duplicate/, 'one job per event');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"status"', `,'WAITING'`)), /ShadowJob_status_check/);
  await rejects(owner.exec(`INSERT INTO "ShadowJob" ("workspaceId","clientId","eventId") VALUES ('w','c1','r3')`), /null value|not-null/, 'a job names its config version');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"attempts"', ',-1')), /attempts_check/);
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"leaseOwner"', `,'w1'`)), /ShadowJob_lease_check/, 'a lease names owner, expiry and token');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"status"', `,'DONE'`)), /ShadowJob_finished_check/, 'a finished job says when');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"status","finishedAt"', `,'FAILED',now()`)), /ShadowJob_error_code_check/, 'a failed job says why');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"status","finishedAt","lastErrorCode","leaseOwner","leaseExpiresAt","claimToken"',
    `,'SKIPPED',now(),'PROVIDER_CIRCUIT_OPEN','w1',now(),gen_random_uuid()`)), /ShadowJob_finished_check/, 'a finished job holds no lease');
  await rejects(owner.exec(shadowJob('c1', 'r3', ',"status"', `,'RETRY'`)), /ShadowJob_error_code_check/);
  await owner.exec(shadowJob('c1', 'r3', ',"status","finishedAt","lastErrorCode"', `,'SKIPPED',now(),'PROVIDER_BUDGET_EXHAUSTED'`));
  await owner.exec(shadowJob('c2', 'r9'));
}

/** Confined runner: shadow jobs follow the client scope like every other client table. */
export async function checkShadowJobRls(app: SqlRunner): Promise<void> {
  assert.equal(Number((await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ShadowJob"`))[0]?.n ?? 0), 0, 'no context: no job');
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c2']);
  assert.deepEqual((await app.query<{ eventId: string }>(`SELECT "eventId" FROM "ShadowJob"`)).map(r => r.eventId), ['r9']);
  await rejects(app.exec(shadowJob('c1', 'r1c')), /row-level security/, 'no job written into another client');
  await app.exec('ROLLBACK');
}

// ---------------------------------------------------------------------------------------------------------------------
// Observation lifecycle (migration 202610072300): immutable evidence, the allowed status changes, acknowledgement with
// author and time, superseding within the client. Owner, after checkStructuralInvariants (o-r1 CRITICAL and o-r3 MEDIUM
// in c1, o-r9 in c2). Leaves o-r3 OPEN as it found it.
// ---------------------------------------------------------------------------------------------------------------------
export async function checkObservationLifecycle(owner: SqlRunner): Promise<void> {
  const update = (set: string) => owner.exec(`UPDATE "Observation" SET ${set} WHERE id = 'o-r3'`);
  for (const set of [`severity = 'LOW', "severityRank" = 1`, `priority = 'URGENT'`, `route = 'MONITOR'`, `"reasonCodes" = ARRAY['X']`,
    `"entityId" = NULL`, `"eventId" = 'r1'`, `confidence = 0.1`, `"decisionRunId" = NULL`]) {
    await rejects(update(set), /evidence is immutable/, `evidence stays: ${set}`);
  }
  await rejects(update(`status = 'ACKNOWLEDGED'`), /acknowledgement_check/, 'an acknowledgement names its author and time');
  await update(`status = 'ACKNOWLEDGED', "acknowledgedAt" = now(), "acknowledgedBy" = 'tech'`);
  await rejects(update(`status = 'OPEN', "acknowledgedAt" = NULL, "acknowledgedBy" = NULL`), /lifecycle allows/, 'ACKNOWLEDGED only moves on to a closure');
  await update(`status = 'RESOLVED', "resolvedAt" = now(), "resolvedBy" = 'tech'`);
  await rejects(update(`status = 'ACKNOWLEDGED'`), /lifecycle allows/);
  await rejects(update(`status = 'OPEN', "resolvedAt" = NULL, "resolvedBy" = NULL`), /acknowledgement_check/, 'reopen clears the acknowledgement');
  await update(`status = 'OPEN', "resolvedAt" = NULL, "resolvedBy" = NULL, "acknowledgedAt" = NULL, "acknowledgedBy" = NULL`);
  await rejects(update(`"supersededById" = 'o-r1'`), /superseded_check/, 'only a suppressed observation is superseded');
  const suppress = `status = 'SUPPRESSED', "resolvedAt" = now(), "resolvedBy" = 'worker'`;
  await rejects(update(`${suppress}, "supersededById" = 'o-r3'`), /superseded_check/, 'never by itself');
  await rejects(update(`${suppress}, "supersededById" = 'o-r9'`), /foreign key/, 'never by an observation of another client');
  await update(`${suppress}, "supersededById" = 'o-r1'`);
  await rejects(update(`status = 'RESOLVED', "supersededById" = NULL`), /lifecycle allows/, 'SUPPRESSED → RESOLVED is not a lifecycle step');
  await update(`status = 'OPEN', "resolvedAt" = NULL, "resolvedBy" = NULL, "supersededById" = NULL`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool execution ledger (migration 202610080000): read tools only, status vocabulary and outcome consistency, identity
// formats, and a STARTED row only records its outcome. Owner, after checkStructuralInvariants (client c1 in w).
// ---------------------------------------------------------------------------------------------------------------------
const hash = 'a'.repeat(64);
const execution = (id: string, columns = '', values = '') => `INSERT INTO "ToolExecution" ("workspaceId","clientId","id","actorId","toolName","toolVersion",
  "riskLevel","sideEffect","inputHash","status","correlationId"${columns}) VALUES ('w','c1','${id}','tech','atera.ticket.list','1',0,'NONE','${hash}','STARTED','corr-12345678'${values})`;
export async function checkToolLedger(owner: SqlRunner): Promise<void> {
  await owner.exec(execution('x1'));
  await rejects(owner.exec(execution('x2').replace(`'1',0,'NONE'`, `'1',2,'NONE'`)), /read_only_check/, 'Stage 1 records read tools only');
  await rejects(owner.exec(execution('x3').replace(`'1',0,'NONE'`, `'1',0,'CREATE'`)), /read_only_check/);
  await rejects(owner.exec(execution('x4').replace(`'1',0,'NONE'`, `'1',0,'WRITE'`)), /side_effect_check|read_only_check/);
  await rejects(owner.exec(execution('x5', ',"finishedAt"', ',now()').replace(`'STARTED'`, `'DONE'`)), /ToolExecution_status_check/);
  await rejects(owner.exec(execution('x6').replace(`'STARTED'`, `'SUCCEEDED'`)), /outcome_check/, 'a finished execution says when');
  await rejects(owner.exec(execution('x7', ',"finishedAt"', ',now()').replace(`'STARTED'`, `'FAILED'`)), /outcome_check/, 'a failed execution says why');
  await rejects(owner.exec(execution('x8').replace(`'${hash}'`, `'abc'`)), /identity_check/);
  await rejects(owner.exec(execution('x9').replace(`'atera.ticket.list'`, `'Atera.Ticket'`)), /identity_check/);
  await rejects(owner.exec(execution('x10').replace(`'corr-12345678'`, `'short'`)), /identity_check/);
  await rejects(owner.exec(`UPDATE "ToolExecution" SET "toolName" = 'atera.alert.list' WHERE id = 'x1'`), /ledger/, 'nothing but the outcome changes');
  await owner.exec(`UPDATE "ToolExecution" SET status = 'SUCCEEDED', "finishedAt" = now() WHERE id = 'x1'`);
  await rejects(owner.exec(`UPDATE "ToolExecution" SET status = 'FAILED', "safeErrorCode" = 'X' WHERE id = 'x1'`), /ledger/, 'an outcome is final');
}
