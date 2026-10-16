import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../support/pg-harness.ts';
import { ACTOR, ACTOR_X, PRICE, RA, RB, RW, RX, RXC, activate, addRemoteFixtures, connectAs, createPolicy, fenceOf, ledger, ownerScoped, pauseOnce, policyRow,
  freshProject, reserveOnce, revise, setClient, settleOnce, sqlstate } from '../support/ask-remote-pg.ts';

// ASK-REMOTE R-A on PostgreSQL 17 (04 "Policy and permission", 05 "Consent revision"): the ask:remote vocabulary without any
// grant; one persistent inactive policy row per workspace with immutable admission/project; strictly +1 policyVersion for
// every material policy/allowlist/pause/revoke/reactivate mutation together with the workspace fence; no-op revisions change
// nothing; no DELETE/recreate; max bigint is a terminal tombstone; a stale consent tuple is refused before any reservation
// even when the caller captured the newer fence epoch. Synthetic disposable data; owner provisioning only via routines.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const runtime = await connectAs(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addRemoteFixtures(owner);

test('permission vocabulary: ask:remote accepted next to every accepted value, nothing granted, unknown values refused', async () => {
  const check = (await owner.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ClientMembership_permissions_check'`)).rows[0].d as string;
  for (const p of ['context:read', 'events:ingest', 'mapping:review', 'connections:manage', 'observations:triage', 'm365:read', 'actions:read', 'actions:request',
    'actions:approve', 'actions:execute', 'poweroffice:read', 'poweroffice:sync', 'poweroffice:maintain', 'ask:remote']) assert.ok(check.includes(`'${p}'`), p);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "ClientMembership" WHERE 'ask:remote' = ANY (permissions)`)).rows[0].n, 0, 'no automatic grant');
  await owner.query('BEGIN');
  try {
    await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,ARRAY['context:read','ask:remote'])`, [RW, RA, ACTOR]);
    assert.equal(await sqlstate(owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['ask:remote:all'] WHERE "actorId" = $1`, [ACTOR])), '23514');
  } finally { await owner.query('ROLLBACK'); }
});

test('creation: one INACTIVE row at version 1 per workspace; admission/project immutable and unique; never recreated or deleted', async () => {
  const f0 = await fenceOf(owner, RW);
  const { admissionId } = await createPolicy(owner, RW, { project: 'synthetic-project-shared' });
  const row = (await policyRow(owner, RW))!;
  assert.deepEqual([row.policyVersion, row.state, row.stateReason, row.admissionId], ['1', 'INACTIVE', null, admissionId]);
  assert.equal(await fenceOf(owner, RW), f0 + 1, 'creation took and advanced the fence');
  assert.equal(await sqlstate(createPolicy(owner, RW)), 'AR009', 'a second policy row for the workspace');
  assert.equal(await sqlstate(createPolicy(owner, RX, { project: 'synthetic-project-shared' })), 'AR009', 'project identity is unique across workspaces');
  assert.equal(await sqlstate(createPolicy(owner, RX, { admissionId })), 'AR009', 'admission identity is unique');
  assert.equal(await sqlstate(createPolicy(owner, RX, { dayCap: '2000001' })), 'AR009', 'caps may only be lowered');
  assert.equal(await sqlstate(createPolicy(owner, RX, { expiresInMs: 169 * 3_600_000 })), 'AR009', 'expiry at most 168 h');
  // Scope: the routine refuses a workspace other than app.workspace_id before any lock.
  assert.equal(await sqlstate(ownerScoped(owner, RX, () => owner.query(`SELECT public.atlas_ask_remote_policy_create($1, $2::uuid, 'p-x', 'fixture://x', 'own', 'ret',
    'pr1', repeat('a', 64), repeat('a', 64), repeat('a', 64), 0, 0, now() + interval '1 hour')`, [RW, randomUUID()]))), 'AR004');
  // Direct owner DML is not provisioning: the guard admits only the confined routines' owner, and never DELETE/TRUNCATE.
  for (const sql of [`UPDATE "RemoteAskPolicy" SET "projectIdentity" = 'synthetic-moved' WHERE "workspaceId" = '${RW}'`,
    `UPDATE "RemoteAskPolicy" SET "policyVersion" = 5 WHERE "workspaceId" = '${RW}'`, `DELETE FROM "RemoteAskPolicy" WHERE "workspaceId" = '${RW}'`,
    `TRUNCATE "RemoteAskPolicy" CASCADE`, `INSERT INTO "RemoteAskPolicy" SELECT * FROM "RemoteAskPolicy"`]) {
    assert.equal(await sqlstate(ownerScoped(owner, RW, () => owner.query(sql))), 'AR007', sql);
  }
  assert.equal((await policyRow(owner, RW))!.policyVersion, '1');
});

test('the confined definer itself cannot skip or rewind versions, move identities or delete (column grants + guard)', async () => {
  await ownerScoped(owner, RW, async () => {
    await owner.query(`SET LOCAL ROLE "${pgdb.remoteRole}"`);
    // Identity columns: no UPDATE grant at all (42501); version skips and DELETE: the guard (AR007 / DELETE grant absent).
    for (const [sql, code] of [[`UPDATE public."RemoteAskPolicy" SET "policyVersion" = "policyVersion" + 2`, 'AR007'],
      [`UPDATE public."RemoteAskPolicy" SET "policyVersion" = "policyVersion" - 1`, 'AR007'],
      [`UPDATE public."RemoteAskPolicy" SET "policyVersion" = "policyVersion" + 1, "revisedAt" = "revisedAt" - interval '1 second'`, 'AR007'],
      [`UPDATE public."RemoteAskPolicy" SET "admissionId" = gen_random_uuid(), "policyVersion" = "policyVersion" + 1`, '42501'],
      [`UPDATE public."RemoteAskPolicy" SET "projectIdentity" = 'synthetic-other', "policyVersion" = "policyVersion" + 1`, '42501'],
      [`UPDATE public."RemoteAskPolicy" SET "workspaceId" = '${RX}', "policyVersion" = "policyVersion" + 1`, '42501'],
      [`DELETE FROM public."RemoteAskPolicy"`, '42501']] as const) {
      await owner.query('SAVEPOINT s');
      assert.equal(await sqlstate(owner.query(sql)), code, sql);
      await owner.query('ROLLBACK TO SAVEPOINT s');
    }
  });
});

test('material revisions advance policyVersion and the fence by exactly one; an identical revision is a no-op; stale expected version refused', async () => {
  const before = (await policyRow(owner, RW))!; const f0 = await fenceOf(owner, RW);
  assert.equal(await revise(owner, RW, {}), before.policyVersion, 'identical revision');
  assert.equal(await fenceOf(owner, RW), f0, 'no fence change for a no-op');
  const changes: Partial<Record<string, string>>[] = [{ priceRevision: 'synthetic-price-rev-2' }, { priceRevision: PRICE }, { dayCapMicroUsd: '1000000' },
    { monthCapMicroUsd: '5000000' }, { secretRef: 'vault://ask-remote/synthetic' }, { ownerApprovalRef: 'synthetic-owner-approval-2' },
    { retentionAttestationRef: 'synthetic-retention-2' }, { promptSha256: 'b'.repeat(64) }, { schemaSha256: 'c'.repeat(64) }, { packageSha256: 'd'.repeat(64) },
    { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }];
  let v = BigInt(before.policyVersion); let f = f0;
  for (const change of changes) {
    assert.equal(await revise(owner, RW, change), String(++v), JSON.stringify(change));
    assert.equal(await fenceOf(owner, RW), ++f);
  }
  assert.equal(await sqlstate(revise(owner, RW, { dayCapMicroUsd: '900000' }, String(v - 1n))), 'AR009', 'lost update refused');
  assert.equal(await sqlstate(revise(owner, RW, { state: 'ACTIVE', expiresAt: new Date(Date.now() - 1000).toISOString() })), 'AR009', 'expired activation');
  assert.equal(await sqlstate(revise(owner, RW, { expiresAt: new Date(Date.now() + 169 * 3_600_000).toISOString() })), 'AR009', 'expiry beyond 168 h');
  assert.equal(await sqlstate(revise(owner, RW, { state: 'TOMBSTONE' })), 'AR009', 'tombstone is never requested');
  assert.equal((await policyRow(owner, RW))!.policyVersion, String(v), 'refusals changed nothing');
});

test('allowlist: exact client admit/remove/re-admit, never deleted, each +1 with the fence; foreign or unknown client refused', async () => {
  let v = BigInt((await policyRow(owner, RW))!.policyVersion); let f = await fenceOf(owner, RW);
  assert.equal(await setClient(owner, RW, RA, true), String(++v)); assert.equal(await fenceOf(owner, RW), ++f);
  assert.equal(await setClient(owner, RW, RA, true), String(v), 'already admitted: no-op'); assert.equal(await fenceOf(owner, RW), f);
  assert.equal(await setClient(owner, RW, RB, false), String(v), 'never admitted, removal: no-op');
  assert.equal(await setClient(owner, RW, RA, false), String(++v)); assert.equal(await setClient(owner, RW, RA, true), String(++v));
  assert.equal(await sqlstate(setClient(owner, RW, RXC, true)), 'AR009', 'a client of another workspace (scoped FK)');
  assert.equal(await sqlstate(setClient(owner, RW, 'no-such-client', true)), 'AR009');
  assert.equal(await sqlstate(setClient(owner, RW, RB, true, String(v - 1n))), 'AR009', 'stale expected version');
  const rows = await ownerScoped(owner, RW, async () => (await owner.query(`SELECT "clientId", state, "changedAtPolicyVersion"::text AS v FROM "RemoteAskClientAdmission"`)).rows);
  assert.deepEqual(rows, [{ clientId: RA, state: 'ADMITTED', v: String(v) }]);
  assert.equal(await sqlstate(ownerScoped(owner, RW, () => owner.query(`DELETE FROM "RemoteAskClientAdmission"`))), 'AR007');
});

test('revoke/pause/reactivate never reuse a version; a stale consent tuple is refused before reserve despite a newer fence epoch', async () => {
  const active = await revise(owner, RW, { state: 'ACTIVE' });
  const admissionId = (await policyRow(owner, RW))!.admissionId;
  const consent = { admissionId, policyVersion: active };
  const first = await reserveOnce(runtime, RW, RA, consent);
  assert.match(first.attemptId, /^[0-9a-f-]{36}$/);
  const revoked = await revise(owner, RW, { state: 'REVOKED' });
  assert.equal(BigInt(revoked), BigInt(active) + 1n);
  const reactivated = await revise(owner, RW, { state: 'ACTIVE' });
  assert.equal(BigInt(reactivated), BigInt(active) + 2n, 'reactivation is a new version; the old tuple stays stale');
  const before = await ledger(owner, RW);
  // The caller captured the CURRENT fence epoch (newer than the consent), yet the old consent tuple is refused first.
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent)), 'AR002');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, { admissionId, policyVersion: revoked })), 'AR002');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, { admissionId: randomUUID(), policyVersion: reactivated })), 'AR002');
  assert.deepEqual(await ledger(owner, RW), before, 'no reservation, counter or attempt for refused tuples');
  // Runtime pause: narrow, fence-first, +1; a paused policy admits nothing; pausing again is a no-op; runtime cannot activate.
  const f = await fenceOf(owner, RW);
  const paused = await pauseOnce(runtime, RW, admissionId, 'USAGE_INVALID');
  assert.equal(BigInt(paused), BigInt(reactivated) + 1n); assert.equal(await fenceOf(owner, RW), f + 1);
  assert.deepEqual([(await policyRow(owner, RW))!.state, (await policyRow(owner, RW))!.stateReason], ['PAUSED', 'USAGE_INVALID']);
  assert.equal(await pauseOnce(runtime, RW, admissionId, 'USAGE_INVALID'), paused, 'already paused');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, { admissionId, policyVersion: paused })), 'AR001', 'correct tuple, inactive policy');
  assert.equal(await sqlstate(runtime.query(`SELECT public.atlas_ask_remote_policy_revise($1, $2::uuid, $3::bigint, 'ACTIVE', 'fixture://x', 'own', 'ret', 'pr1',
    repeat('a', 64), repeat('a', 64), repeat('a', 64), 0, 0, now())`, [RW, admissionId, paused])), '42501', 'runtime cannot revise/activate');
  for (const fn of ['atlas_ask_remote_policy_create', 'atlas_ask_remote_client_set', 'atlas_ask_remote_guard', 'atlas_ask_remote_ledger_check']) {
    const r = (await runtime.query(`SELECT bool_or(has_function_privilege(oid, 'EXECUTE')) AS x FROM pg_proc WHERE proname = $1`, [fn])).rows[0];
    assert.equal(r.x, false, fn);
  }
  assert.equal(await sqlstate(pauseOnce(runtime, RX, admissionId)), 'AR004', 'foreign workspace admission');
});

test('max bigint: reaching it deactivates atomically into a terminal TOMBSTONE; no reactivation, mutation, overflow or reserve', async () => {
  const { admissionId } = await activate(owner, RX, [RXC]);
  // TEST-ONLY aging: move the counter to max-2 with the user triggers briefly disabled (the routines can only add one).
  await ownerScoped(owner, RX, async () => {
    await owner.query(`ALTER TABLE "RemoteAskPolicy" DISABLE TRIGGER USER`);
    await owner.query(`UPDATE "RemoteAskPolicy" SET "policyVersion" = 9223372036854775805 WHERE "workspaceId" = $1`, [RX]);
    await owner.query(`ALTER TABLE "RemoteAskPolicy" ENABLE ALWAYS TRIGGER "RemoteAskPolicy_guard", ENABLE ALWAYS TRIGGER "RemoteAskPolicy_truncate"`);
  });
  const x = { actor: ACTOR_X, priceRevision: 'synthetic-price-rev-9' };
  const nearMax = await revise(owner, RX, { priceRevision: x.priceRevision });
  assert.equal(nearMax, '9223372036854775806');
  assert.equal((await policyRow(owner, RX))!.state, 'ACTIVE');
  const attempt = await reserveOnce(runtime, RX, RXC, { admissionId, policyVersion: nearMax }, x);
  // The next material mutation (here an allowlist removal) reaches max: inactive TOMBSTONE in the same transaction.
  const max = await setClient(owner, RX, RXC, false);
  assert.equal(max, '9223372036854775807');
  assert.deepEqual([(await policyRow(owner, RX))!.state, (await policyRow(owner, RX))!.stateReason], ['TOMBSTONE', 'VERSION_EXHAUSTED']);
  assert.equal(await sqlstate(reserveOnce(runtime, RX, RXC, { admissionId, policyVersion: max }, x)), 'AR001', 'egress refuses max');
  assert.equal(await sqlstate(revise(owner, RX, { state: 'ACTIVE' })), 'AR008', 'no reactivation');
  assert.equal(await sqlstate(revise(owner, RX, { dayCapMicroUsd: '0' })), 'AR008', 'no further material mutation');
  assert.equal(await sqlstate(setClient(owner, RX, RXC, true)), 'AR008');
  assert.equal(await pauseOnce(runtime, RX, admissionId), max, 'pause of a terminal policy is a no-op (no overflow)');
  assert.equal(await sqlstate(createPolicy(owner, RX)), 'AR009', 'delete/recreate cannot restore an old tuple or reset the counter');
  await ownerScoped(owner, RX, async () => {
    await owner.query(`SET LOCAL ROLE "${pgdb.remoteRole}"`);
    assert.equal(await sqlstate(owner.query(`UPDATE public."RemoteAskPolicy" SET state = 'PAUSED', "stateReason" = 'OWNER'`)), 'AR008');
  });
  // Bookkeeping of the earlier admitted attempt still settles (financial-only), and keeps its captured version.
  assert.equal(await settleOnce(runtime, RX, RXC, attempt, 'DELIVERY_UNKNOWN'), '300000');
  assert.equal((await ledger(owner, RX)).attempts[0]!.policyVersion, nearMax);
});

test('RC2 R1: an ordinary revision never raises either cap above its CURRENT value; refusal changes nothing; lowering/no-op/history intact', async () => {
  const p = await freshProject(owner, 'caps', { dayCap: '600000', monthCap: '900000' });
  await reserveOnce(runtime, p.ws, p.client, p, { actor: p.actor });
  const state = async () => ({ policy: await policyRow(owner, p.ws), fence: await fenceOf(owner, p.ws), ledger: await ledger(owner, p.ws) });
  const refused = async (label: string, changes: Record<string, string>) => {
    const before = await state();
    assert.equal(await sqlstate(revise(owner, p.ws, changes)), 'AR009', label);
    assert.deepEqual(await state(), before, `${label}: policy, version, fence, counters and history unchanged`);
  };
  const renewed = new Date(Date.now() + 48 * 3_600_000).toISOString();
  await refused('day +1 alone, same approval reference', { dayCapMicroUsd: '600001' });
  await refused('month +1 alone, same approval reference', { monthCapMicroUsd: '900001' });
  await refused('both raised', { dayCapMicroUsd: '900000', monthCapMicroUsd: '1200000' });
  await refused('raise with a new approval reference', { dayCapMicroUsd: '700000', ownerApprovalRef: 'synthetic-owner-approval-raise' });
  await refused('raise with an expiry renewal', { monthCapMicroUsd: '1000000', expiresAt: renewed });
  await refused('raise while lowering the other cap', { dayCapMicroUsd: '300000', monthCapMicroUsd: '1000000' });
  await refused('raise together with revoke', { state: 'REVOKED', dayCapMicroUsd: '600001' });
  const v0 = BigInt((await policyRow(owner, p.ws))!.policyVersion);
  assert.equal(await revise(owner, p.ws, { state: 'REVOKED' }), String(v0 + 1n), 'revoke without raising');
  await refused('reactivation that raises', { state: 'ACTIVE', monthCapMicroUsd: '900001' });
  assert.equal(await revise(owner, p.ws, { state: 'ACTIVE', expiresAt: renewed, ownerApprovalRef: 'synthetic-owner-approval-3' }), String(v0 + 2n),
    'reactivation + renewal + new reference with the same caps');
  assert.equal(await revise(owner, p.ws, { dayCapMicroUsd: '300000' }), String(v0 + 3n), 'lowering is a normal revision');
  assert.equal(await revise(owner, p.ws, {}), String(v0 + 3n), 'identical revision: no-op');
  await refused('raising back to the earlier cap', { dayCapMicroUsd: '600000' });
  assert.equal(await revise(owner, p.ws, { dayCapMicroUsd: '300000', monthCapMicroUsd: '900000' }), String(v0 + 3n), 'equal caps are not an increase');
  const row = (await policyRow(owner, p.ws))!;
  assert.deepEqual([row.dayCapMicroUsd, row.monthCapMicroUsd], ['300000', '900000']);
  assert.deepEqual((await ledger(owner, p.ws)).counters.map(c => c.charged), ['300000', '300000'], 'counters never rewritten');
  // Defense in depth: even the confined definer cannot write a higher cap directly.
  await ownerScoped(owner, p.ws, async () => {
    await owner.query(`SET LOCAL ROLE "${pgdb.remoteRole}"`);
    assert.equal(await sqlstate(owner.query(`UPDATE public."RemoteAskPolicy" SET "dayCapMicroUsd" = 300001, "policyVersion" = "policyVersion" + 1`)), 'AR007');
  });
});
