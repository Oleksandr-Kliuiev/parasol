import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { verifyFixture } from '../../packages/reval/fixture-verify.ts';
import { MaintenanceRefusal } from '../../packages/reval/inventory.ts';
import type { MaintenanceCode } from '../../packages/reval/inventory.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { adminUrl } from '../support/pg-harness.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { PRICE } from '../support/ask-remote-pg.ts';
import { syntheticLedger } from '../support/reval-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { ACTOR, CLIENT, WS, dataset, install, ownerTx, pidOf, provisionSandbox, q, registration, runtimeClient, state } from '../support/reval-fixture-pg.ts';

// R-EVAL RS-B maintenance refusals and atomicity on PostgreSQL 17 (rs-b brief B5–B7; 05 "Fixtures": atomic switch rollback,
// foreign DB/extra rows/FK dependency refusal, no finance/audit reset or trigger bypass). NON-superuser table owner. Every
// refusal leaves the binding generation, the scoped source rows, the fence and the finance/audit/identity fingerprint
// exactly as before. A superuser client is opened only to write the synthetic ledger and closed before any switch.
const ns = await nonsuperDatabase();
await ns.admin.end();
const { db } = ns; const owner = db.owner;
after(async () => { await ns.cleanup(); });
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole);
const pid = await pidOf(owner);
const refusal = (code: MaintenanceCode) => (e: unknown) => e instanceof MaintenanceRefusal && e.code === code;
async function superuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const u = new URL(adminUrl()); u.pathname = `/${db.name}`;
  const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
/** The switch refuses with `code` and changes nothing (binding, rows, fence, finance/audit fingerprint). */
async function refusesUnchanged(code: MaintenanceCode, fixtureId: string, expected: string, o: { pids?: string[]; reg?: typeof r; ds?: typeof dataset } = {}): Promise<void> {
  const before = await state(owner, r);
  await assert.rejects(install(owner, o.reg ?? r, fixtureId, expected, o.pids ?? [pid], undefined, o.ds), refusal(code), code);
  assert.deepEqual(await state(owner, r), before, `${code}: nothing changed`);
}

test('before registration every switch refuses UNREGISTERED; registration needs a PAUSED policy (INACTIVE refused, rc2 F2) and is single', async () => {
  await assert.rejects(install(owner, r, 'FX01', '0', [pid]), refusal('UNREGISTERED'));
  await revise(owner, WS, { state: 'INACTIVE' });
  await assert.rejects(registerSandbox(q(owner), r, [pid]), refusal('POLICY_NOT_PAUSED'), 'ACTIVE→INACTIVE is a legal revision: INACTIVE proves nothing');
  await revise(owner, WS, { state: 'PAUSED' });
  await registerSandbox(q(owner), r, [pid]);
  await assert.rejects(registerSandbox(q(owner), { ...r, registrationId: randomUUID(), databaseInstanceId: randomUUID() }, [pid]), refusal('ALREADY_REGISTERED'));
  const first = await install(owner, r, 'FX02', '0', [pid]);
  assert.equal(first.generation, '1');
});

test('finance, audit and history rows survive switches byte-for-byte; settled attempts and audit stay; unsettled attempt refuses DRAIN_INCOMPLETE', async () => {
  const project = { ws: WS, client: CLIENT, actor: ACTOR, admissionId, policyVersion: '1', project: `synthetic-project-${WS}` };
  await superuser(c => syntheticLedger(c, db.remoteRole, project, [{ createdAt: '2026-10-11T08:00:00.000Z', clientId: CLIENT, actorId: ACTOR, outcome: 'NO_DISPATCH' }], PRICE));
  await ownerTx(owner, () => owner.query(`INSERT INTO "AuditEvent" ("workspaceId", "clientId", id, "actorId", "eventType", "correlationId", metadata)
    VALUES ($1, $2, 'syn-audit-1', $3, 'ask.remote.synthetic', 'syn-corr-1', '{}'::jsonb)`, [WS, CLIENT, ACTOR]));
  const before = await state(owner, r);
  await install(owner, r, 'FX08', '1', [pid]); await install(owner, r, 'FX03', '2', [pid]);
  const after1 = await state(owner, r);
  assert.equal(after1.preserved, before.preserved, 'ledger, counters, audit, actors, registration unchanged');
  assert.ok(after1.preserved.includes('RemoteAskAttempt=1:') && after1.preserved.includes('AuditEvent=1:'), after1.preserved);
  await superuser(c => syntheticLedger(c, db.remoteRole, project, [{ createdAt: '2026-10-11T09:00:00.000Z', clientId: CLIENT, actorId: ACTOR, outcome: 'EGRESS' }], PRICE));
  await refusesUnchanged('DRAIN_INCOMPLETE', 'FX01', '3');
  await superuser(c => c.query(`UPDATE "RemoteAskAttempt" SET state = 'SETTLED', outcome = 'NO_DISPATCH', "accountedMicroUsd" = 0, "settledAt" = "createdAt" + interval '1 second'
    WHERE "workspaceId" = $1 AND state = 'EGRESS_COMMITTED'`, [WS]).then(() => c.query(`UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = 0 WHERE "workspaceId" = $1`, [WS]))
    .catch(async () => { /* the deferred ledger invariant is enforced by the accepted guard; settle through the definer instead */
      await c.query('BEGIN'); await c.query(`SET LOCAL ROLE "${db.remoteRole}"`);
      await c.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
      await c.query(`UPDATE "RemoteAskAttempt" SET state = 'SETTLED', outcome = 'NO_DISPATCH', "accountedMicroUsd" = 0, "settledAt" = "createdAt" + interval '1 second'
        WHERE "workspaceId" = $1 AND state = 'EGRESS_COMMITTED'`, [WS]);
      await c.query(`UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = 0 WHERE "workspaceId" = $1`, [WS]); await c.query('COMMIT');
    }));
  assert.equal((await install(owner, r, 'FX01', '3', [pid])).generation, '4', 'settled again → switch proceeds');
});

test('refusals: wrong generation, ACTIVE policy, another backend, live connection, extra rows, FK dependency, registration mismatch', async () => {
  const gen = (await state(owner, r)).gen!;
  await refusesUnchanged('GENERATION_MISMATCH', 'FX05', '0');
  await refusesUnchanged('GENERATION_MISMATCH', 'FX05', String(BigInt(gen) + 1n));
  // Another client backend on the sandbox (e.g. a running API server).
  const other = await runtimeClient(db.runtimeUrl);
  try { await refusesUnchanged('ANOTHER_WRITER', 'FX05', gen); } finally { await other.end(); }
  // ACTIVE policy (unpaused) → refuse; PAUSED again → allowed.
  await revise(owner, WS, { state: 'ACTIVE' });
  await refusesUnchanged('POLICY_NOT_PAUSED', 'FX05', gen);
  await revise(owner, WS, { state: 'INACTIVE' }); // rc2 F2: INACTIVE after ACTIVE is a legal owner revision → refused too
  await refusesUnchanged('POLICY_NOT_PAUSED', 'FX05', gen);
  await revise(owner, WS, { state: 'PAUSED' });
  // A live/non-fixture connection anywhere.
  await ownerTx(owner, () => owner.query(`INSERT INTO "Connection" ("workspaceId", "clientId", id, system, "externalTenantId", "secretRef", status)
    VALUES ($1, $2, 'syn-live-1', 'atera', 'live-tenant', 'secret://x', 'DISABLED')`, [WS, CLIENT]));
  await refusesUnchanged('LIVE_EGRESS', 'FX05', gen);
  await ownerTx(owner, () => owner.query(`DELETE FROM "Connection" WHERE id = 'syn-live-1'`));
  // An extra scoped source row that is not the installed plan.
  await ownerTx(owner, () => owner.query(`INSERT INTO "Entity" ("workspaceId", "clientId", id, kind) VALUES ($1, $2, 'syn-extra-entity', 'DEVICE')`, [WS, CLIENT]));
  await refusesUnchanged('EXTRA_ROWS', 'FX05', gen);
  await ownerTx(owner, () => owner.query(`DELETE FROM "Entity" WHERE id = 'syn-extra-entity'`));
  // An extra client and an extra actor in the workspace.
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, 'syn-other-client', 'Other')`, [WS]);
  await refusesUnchanged('EXTRA_ROWS', 'FX05', gen);
  await ownerTx(owner, () => owner.query(`DELETE FROM "Client" WHERE id = 'syn-other-client'`));
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, 'syn-other-actor', 'Other')`, [WS]);
  await refusesUnchanged('EXTRA_ROWS', 'FX05', gen);
  await ownerTx(owner, async () => { await owner.query(`SELECT set_config('app.actor_id', 'syn-other-actor', true)`); await owner.query(`DELETE FROM "Actor" WHERE id = 'syn-other-actor'`); });
  // A row outside the allowlist referencing a scoped source row (DecisionRun → RawEvent): refuse, never cascade.
  const raw = (await ownerTx(owner, () => owner.query(`SELECT id FROM "RawEvent" WHERE "workspaceId" = $1 LIMIT 1`, [WS]))).rows[0].id as string;
  await ownerTx(owner, () => owner.query(`INSERT INTO "DecisionRun" ("workspaceId", "clientId", id, "eventId", provider, "promptVersion", "inputHash", status, "safeErrorCode")
    VALUES ($1, $2, 'syn-dr-1', $3, 'rules', 'p', 'h', 'FAILED', 'SYNTHETIC')`, [WS, CLIENT, raw]));
  await refusesUnchanged('FK_DEPENDENCY', 'FX05', gen);
  await ownerTx(owner, () => owner.query(`DELETE FROM "DecisionRun" WHERE id = 'syn-dr-1'`));
  // The registration must match the owner record exactly (build digest, reader role, IDs).
  await refusesUnchanged('REGISTRATION_MISMATCH', 'FX05', gen, { reg: { ...r, buildManifestSha256: 'd'.repeat(64) } });
  await refusesUnchanged('REGISTRATION_MISMATCH', 'FX05', gen, { reg: { ...r, evidenceReaderRole: db.runtimeRole } });
  await refusesUnchanged('REGISTRATION_MISMATCH', 'FX05', gen, { reg: { ...r, registrationId: randomUUID() } });
  assert.equal((await install(owner, r, 'FX05', gen, [pid])).generation, String(BigInt(gen) + 1n), 'everything restored → switch proceeds');
});

test('atomic switch: a failure after DELETE+INSERT rolls back completely (previous fixture, generation, fence, fingerprint intact)', async () => {
  const s0 = await state(owner, r);
  await assert.rejects(install(owner, r, 'FX11', s0.gen!, [pid], { afterInsert: async () => { throw new Error('injected failure after INSERT'); } }),
    refusal('INTERNAL_FAILURE'));
  assert.deepEqual(await state(owner, r), s0);
  const rt = await runtimeClient(db.runtimeUrl);
  try { assert.equal((await verifyFixture(q(rt), { ...r, fixtureId: s0.fixture!, fixtureGeneration: s0.gen! }, 1500)).kind, 'CHECKED'); } finally { await rt.end(); }
});

test('verifier tamper/authority negatives: edited source row, extra row, suspended actor, missing permission, foreign reference', async () => {
  const s0 = await state(owner, r);
  const req = { ...r, fixtureId: s0.fixture!, fixtureGeneration: s0.gen! };
  const verify = async () => { const rt = await runtimeClient(db.runtimeUrl); try { return await verifyFixture(q(rt), req, 1500); } finally { await rt.end(); } };
  const raw = (await ownerTx(owner, () => owner.query(`SELECT id, normalized FROM "RawEvent" WHERE "workspaceId" = $1 ORDER BY id LIMIT 1`, [WS]))).rows[0];
  await ownerTx(owner, () => owner.query(`UPDATE "RawEvent" SET normalized = jsonb_set(normalized, '{summary}', '"forged summary"') WHERE id = $1`, [raw.id]));
  const forged = await verify();
  assert.equal(forged.kind, 'CHECKED');
  if (forged.kind === 'CHECKED') { assert.equal(forged.rowIdentity, true); assert.equal(forged.sourceProjection, false); assert.equal(forged.expectedFacts, false); }
  await ownerTx(owner, () => owner.query(`UPDATE "RawEvent" SET normalized = $2::jsonb WHERE id = $1`, [raw.id, JSON.stringify(raw.normalized)]));
  await ownerTx(owner, () => owner.query(`INSERT INTO "Entity" ("workspaceId", "clientId", id, kind) VALUES ($1, $2, 'syn-extra-entity', 'DEVICE')`, [WS, CLIENT]));
  const extra = await verify();
  assert.ok(extra.kind === 'CHECKED' && extra.rowIdentity === false, JSON.stringify(extra));
  await ownerTx(owner, () => owner.query(`DELETE FROM "Entity" WHERE id = 'syn-extra-entity'`));
  await owner.query(`BEGIN`); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)`, [WS, ACTOR]);
  await owner.query(`UPDATE "Actor" SET status = 'DISABLED' WHERE id = $1`, [ACTOR]); await owner.query('COMMIT');
  assert.deepEqual(await verify(), { kind: 'REFUSED', code: 'UNAUTHORIZED' });
  await owner.query(`BEGIN`); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)`, [WS, ACTOR]);
  await owner.query(`UPDATE "Actor" SET status = 'ACTIVE' WHERE id = $1`, [ACTOR]);
  await owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "actorId" = $1`, [ACTOR]); await owner.query('COMMIT');
  assert.deepEqual(await verify(), { kind: 'REFUSED', code: 'UNAUTHORIZED' });
  await owner.query(`BEGIN`); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)`, [WS, ACTOR]);
  await owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read', 'ask:remote'] WHERE "actorId" = $1`, [ACTOR]); await owner.query('COMMIT');
  assert.deepEqual(await verify(), { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: true });
  assert.deepEqual(await (async () => { const rt = await runtimeClient(db.runtimeUrl); try { return await verifyFixture(q(rt), { ...req, databaseInstanceId: randomUUID() }, 1500); } finally { await rt.end(); } })(),
    { kind: 'REFUSED', code: 'REGISTRATION_MISMATCH' });
});

test('rc2 B1: the frozen FX04 materializes its excluded CANDIDATE link via the owner-approved exception; the reader keeps the entity UNRESOLVED; a non-matching variant is PLAN_INVALID', async () => {
  const s0 = await state(owner, r);
  const res = await install(owner, r, 'FX04', s0.gen!, [pid]);
  const links = (await ownerTx(owner, () => owner.query(`SELECT l.status, l."resourceType", x."externalId" FROM "EntityLink" l
    JOIN "ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId" WHERE l."workspaceId" = $1`, [WS]))).rows;
  assert.deepEqual(links, [{ status: 'CANDIDATE', resourceType: 'contact', externalId: 'syn-h-agent-0009' }]);
  const rt = await runtimeClient(db.runtimeUrl);
  try {
    assert.deepEqual(await verifyFixture(q(rt), { ...r, fixtureId: 'FX04', fixtureGeneration: res.generation }, 1500),
      { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: true });
  } finally { await rt.end(); }
  // A declaration that does not exactly match the exception (in-memory variant, NOT frozen data) stays unrepresentable.
  const file = structuredClone(dataset.file);
  (file.fixtures.find(f => f.fixtureId === 'FX02')!.links as unknown as { resourceType: string }[])[0]!.resourceType = 'contact';
  const ds = { ...dataset, file, byId: new Map(file.fixtures.map(f => [f.fixtureId as never, f])) };
  await refusesUnchanged('PLAN_INVALID', 'FX02', res.generation, { ds });
});

test('foreign workspace in the sandbox database refuses every switch (customer-data isolation)', async () => {
  const gen = (await state(owner, r)).gen!;
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ('foreign-ws', 'Not synthetic')`);
  await refusesUnchanged('EXTRA_ROWS', 'FX02', gen);
});

test('rc2 F3: every verifier boolean is wired — tampered intent expectations make ONLY allFiveIntents false; a tampered bank makes expectedFacts false', async () => {
  const s0 = await state(owner, r);
  const id = s0.fixture!;
  const tamper = (change: (e: any) => void) => {
    const file = structuredClone(dataset.file);
    change(file.fixtures.find(f => f.fixtureId === id)!.expected);
    return { ...dataset, file, byId: new Map(file.fixtures.map(f => [f.fixtureId as never, f])) };
  };
  const verify = async (ds: typeof dataset) => { const rt = await runtimeClient(db.runtimeUrl); try { return await verifyFixture(q(rt), { ...r, fixtureId: id, fixtureGeneration: s0.gen! }, 1500, { dataset: ds }); } finally { await rt.end(); } };
  assert.deepEqual(await verify(tamper(e => { e.intents.SUMMARY.status = e.intents.SUMMARY.status === 'ANSWER' ? 'INSUFFICIENT' : 'ANSWER'; })),
    { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: false });
  assert.deepEqual(await verify(tamper(e => { e.intents.UNSUPPORTED.claims = [['OBSERVATION_RECORDED', 'O:x']]; })),
    { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: false });
  const bankTamper = await verify(tamper(e => { e.coverage.observationsRead = Number(e.coverage.observationsRead) + 1; }));
  assert.ok(bankTamper.kind === 'CHECKED' && bankTamper.expectedFacts === false && bankTamper.rowIdentity && bankTamper.sourceProjection, JSON.stringify(bankTamper));
  assert.deepEqual(await verify(dataset), { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: true });
});

test('rc2 F4/F8: other-writer predicate — every foreign backend type counts, only autovacuum (visible, or NULL type + NULL user) is excluded', async () => {
  const rows = `(VALUES (101, 'client backend', 10::oid), (102, 'client backend', 10::oid), (103, NULL, 10::oid), (104, 'autovacuum worker', NULL::oid),
    (105, NULL, NULL::oid), (106, 'parallel worker', 10::oid), (107, 'background worker', 10::oid), (108, 'walsender', 10::oid), (109, 'logical replication worker', 10::oid))
    a(pid, backend_type, usesysid)`;
  const { OTHER_WRITER_PREDICATE } = await import('../../packages/reval/inventory.ts');
  const counted = (await owner.query(`SELECT array_agg(a.pid ORDER BY a.pid) AS p FROM ${rows} WHERE ${OTHER_WRITER_PREDICATE}`, [['101']])).rows[0].p;
  assert.deepEqual(counted, [102, 103, 106, 107, 108, 109], 'own pid and autovacuum excluded; foreign clients (also with hidden type) and workers counted');
});

