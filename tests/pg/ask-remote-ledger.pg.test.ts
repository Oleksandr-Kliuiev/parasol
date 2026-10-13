import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { utcPeriods } from '../../packages/ask/remote/budget.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { waitUntilBlocked } from '../support/pg-race.ts';
import { ACTOR_X, PRICE, RA, RB, RW, RX, RXC, activate, addRemoteFixtures, connectAs, fenceOf, freshProject, ledger, ownerScoped, policyRow, reserveOnce, revise,
  settleOnce, sqlstate } from '../support/ask-remote-pg.ts';

// ASK-REMOTE R-A financial ledger on PostgreSQL 17 (04 "Durable model of money", 05 "Atomic billing"): reserve MONTH→DAY with
// exact cap checks, exactly-once settlement against the ORIGINAL UTC periods, conservative unknown outcomes, no refund by time
// or restart, scoped refusals, the deferred ledger invariant and no runtime table DML. Synthetic data; no provider exists.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const runtime = await connectAs(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addRemoteFixtures(owner);
const policy = await activate(owner, RW, [RA]);
let consent = { admissionId: policy.admissionId, policyVersion: policy.policyVersion };
// A second project (other workspace) absorbs the retained unknown-outcome reservations, keeping RW's day budget for the rest.
const policyX = await activate(owner, RX, [RXC]);
const sum = (l: Awaited<ReturnType<typeof ledger>>, kind: string) => l.counters.filter(c => c.kind === kind).reduce((a, c) => a + BigInt(c.charged), 0n);

test('storage holds only fixed identities, references, codes and integer accounting: no question/body/hash/length/provider ID/URL column', async () => {
  const columns = async (t: string) => (await owner.query(`SELECT array_agg(attname::text ORDER BY attnum) AS c FROM pg_attribute WHERE attrelid = $1::regclass
    AND attnum > 0 AND NOT attisdropped`, [`public."${t}"`])).rows[0].c as string[];
  assert.deepEqual(await columns('RemoteAskAttempt'), ['workspaceId', 'id', 'clientId', 'actorId', 'admissionId', 'projectIdentity', 'policyVersion', 'profile',
    'priceRevision', 'correlationId', 'dayStart', 'monthStart', 'reservedMicroUsd', 'promptRate', 'completionRate', 'accountedMicroUsd', 'state', 'outcome',
    'promptTokens', 'completionTokens', 'createdAt', 'settledAt']);
  assert.deepEqual(await columns('RemoteAskPeriodCounter'), ['workspaceId', 'projectIdentity', 'kind', 'periodStart', 'chargedMicroUsd', 'createdAt', 'updatedAt']);
  assert.deepEqual(await columns('RemoteAskClientAdmission'), ['workspaceId', 'admissionId', 'clientId', 'state', 'changedAtPolicyVersion', 'createdAt', 'updatedAt']);
  for (const t of ['RemoteAskPolicy', 'RemoteAskAttempt', 'RemoteAskPeriodCounter', 'RemoteAskClientAdmission']) {
    for (const c of await columns(t)) assert.doesNotMatch(c, /question|body|hash|length|request(Id)?$|response|url|provider|model|text|content/i, `${t}.${c}`);
  }
});

test('reserve: creates both UTC counters safely, charges both by exactly 300000 and records the captured identities; session TimeZone is irrelevant', async () => {
  const attempts: { attemptId: string; correlationId: string }[] = [];
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    await runtime.query(`SET TIME ZONE '${zone}'`);
    attempts.push(await reserveOnce(runtime, RW, RA, consent));
  }
  await runtime.query('RESET TIME ZONE');
  const l = await ledger(owner, RW);
  assert.equal(l.counters.length, 2, 'one MONTH and one DAY row');
  assert.deepEqual(l.counters.map(c => c.charged), ['600000', '600000']);
  const created = (await ownerScoped(owner, RW, async () => (await owner.query(`SELECT id::text, to_char("createdAt" AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM "RemoteAskAttempt"`)).rows)) as { id: string; at: string }[];
  for (const a of l.attempts) {
    const at = created.find(c => c.id === a.id)!.at;
    assert.deepEqual([a.dayStart, a.monthStart], [utcPeriods(new Date(at)).day, utcPeriods(new Date(at)).month], 'UTC periods of the DB clock');
    assert.deepEqual([a.state, a.accounted, a.clientId, a.policyVersion, a.outcome], ['EGRESS_COMMITTED', '300000', RA, consent.policyVersion, null]);
  }
  assert.deepEqual(l.counters.map(c => c.periodStart), [l.attempts[0]!.dayStart, l.attempts[0]!.monthStart]);
  // Proven in-process no-dispatch (the caller never consumed a dispatch capability), inside the window: settle 0.
  for (const a of attempts) assert.equal(await settleOnce(runtime, RW, RA, a, 'NO_DISPATCH'), '0');
  assert.deepEqual((await ledger(owner, RW)).counters.map(c => c.charged), ['0', '0']);
});

test('settle exactly once: verified usage keeps ceil cost and refunds the rest to the original periods; duplicates and other scopes refused', async () => {
  const a = await reserveOnce(runtime, RW, RA, consent);
  const before = await ledger(owner, RW);
  assert.equal(await settleOnce(runtime, RW, RA, a, 'USAGE_VERIFIED', { promptTokens: 1201, completionTokens: 33 }), '358'); // 330275 + 27225 → 358
  const after1 = await ledger(owner, RW);
  assert.equal(sum(after1, 'DAY'), sum(before, 'DAY') - 299_642n); assert.equal(sum(after1, 'MONTH'), sum(before, 'MONTH') - 299_642n);
  assert.equal(await sqlstate(settleOnce(runtime, RW, RA, a, 'USAGE_VERIFIED', { promptTokens: 0, completionTokens: 0 })), 'AR006', 'no second refund');
  assert.equal(await sqlstate(settleOnce(runtime, RW, RA, a, 'DELIVERY_UNKNOWN')), 'AR006');
  assert.deepEqual(await ledger(owner, RW), after1);
  const b = await reserveOnce(runtime, RW, RA, consent);
  assert.equal(await sqlstate(settleOnce(runtime, RW, RB, b, 'NO_DISPATCH')), 'AR006', 'another client cannot settle it');
  assert.equal(await sqlstate(settleOnce(runtime, RX, RXC, b, 'NO_DISPATCH')), 'AR006', 'invisible from another workspace');
  assert.equal(await sqlstate(settleOnce(runtime, RW, RA, { ...b, correlationId: randomUUID() }, 'NO_DISPATCH')), 'AR006', 'wrong correlation');
  assert.equal(await sqlstate(settleOnce(runtime, RW, RA, { ...b, attemptId: a.attemptId }, 'NO_DISPATCH')), 'AR006', 'another attempt');
  // Scope arguments must equal the transaction settings; out-of-range usage is refused by the routine itself.
  const raw = (client: string, setting: string, outcome: string, p: number | null, c: number | null) => ownerless(setting, () =>
    runtime.query(`SELECT public.atlas_ask_remote_settle($1, $2, $3::uuid, $4::uuid, $5, $6, $7)`, [RW, client, b.attemptId, b.correlationId, outcome, p, c]));
  assert.equal(await sqlstate(raw(RA, RB, 'NO_DISPATCH', null, null)), 'AR004');
  assert.equal(await sqlstate(raw(RA, RA, 'USAGE_VERIFIED', 32769, 0)), 'AR006');
  assert.equal(await sqlstate(raw(RA, RA, 'USAGE_VERIFIED', 0, 513)), 'AR006');
  assert.equal(await sqlstate(raw(RA, RA, 'USAGE_VERIFIED', null, 5)), 'AR006');
  assert.equal(await sqlstate(raw(RA, RA, 'MODEL_MISMATCH', 5, 5)), 'AR006', 'usage only with a verified outcome');
  assert.equal(await sqlstate(raw(RA, RA, 'REFUND', null, null)), 'AR006');
  assert.equal(await settleOnce(runtime, RW, RA, b, 'NO_DISPATCH'), '0', 'proven in-process no-dispatch inside the window');
  const consentX = { admissionId: policyX.admissionId, policyVersion: policyX.policyVersion };
  for (const outcome of ['DELIVERY_UNKNOWN', 'USAGE_INVALID', 'MODEL_MISMATCH', 'UPSTREAM_REJECTED'] as const) {
    const u = await reserveOnce(runtime, RX, RXC, consentX, { actor: ACTOR_X });
    assert.equal(await settleOnce(runtime, RX, RXC, u, outcome), '300000', outcome);
  }
  for (const ws of [RW, RX]) {
    const l = await ledger(owner, ws);
    assert.equal(sum(l, 'DAY'), l.attempts.reduce((x, t) => x + BigInt(t.accounted!), 0n), 'counter = sum of accounted');
  }
  assert.equal(sum(await ledger(owner, RX), 'DAY'), 1_200_000n, 'unknown outcomes keep the whole reserve');
});
async function ownerless<T>(client: string, fn: () => Promise<T>): Promise<T> {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [RW, client]);
    const out = await fn(); await runtime.query('COMMIT'); return out;
  } catch (error) { await runtime.query('ROLLBACK').catch(() => undefined); throw error; }
}

test('reserve refusals are fixed and reserve nothing: scope, epoch, client, actor, price, profile, expiry; rollback charges neither', async () => {
  const before = await ledger(owner, RW);
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RB, consent)), 'AR001', 'client not on the allowlist');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RXC, consent)), 'AR001', 'client of another workspace');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { actor: ACTOR_X })), 'AR004', 'actor of another workspace (scoped FK)');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { scopeWorkspace: RX })), 'AR004', 'workspace setting differs');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { scopeClient: RB })), 'AR004', 'client setting differs');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { fenceVersion: (await fenceOf(owner, RW)) - 1 })), 'AR005', 'stale authority epoch');
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { priceRevision: 'synthetic-price-rev-0' })), 'AR001', 'price revision');
  const dup = randomUUID(); await reserveOnce(runtime, RW, RA, consent, { correlationId: dup });
  const afterDup = await ledger(owner, RW);
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent, { correlationId: dup })), 'AR004', 'a correlation ID is never reused');
  assert.equal(await sqlstate(ownerless(RA, () => runtime.query(`SELECT public.atlas_ask_remote_reserve($1, $2, 'rem-actor', $3::uuid, $4::bigint,
    (SELECT version FROM "ActionAuthorityFence"), 'other-profile', $5, gen_random_uuid())`, [RW, RA, consent.admissionId, consent.policyVersion, PRICE]))), 'AR001');
  assert.deepEqual(await ledger(owner, RW), afterDup);
  assert.equal(afterDup.attempts.length, before.attempts.length + 1);
  // Rollback of the egress transaction charges neither counter (and creates none).
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [RW, RA]);
  await runtime.query(`SELECT public.atlas_ask_remote_reserve($1, $2, 'rem-actor', $3::uuid, $4::bigint, (SELECT version FROM "ActionAuthorityFence"),
    'ask-remote-openai-luna-v1', $5, gen_random_uuid())`, [RW, RA, consent.admissionId, consent.policyVersion, PRICE]);
  await runtime.query('ROLLBACK');
  assert.deepEqual(await ledger(owner, RW), afterDup);
  // Expiry is checked on the DB clock at the routine boundary.
  consent = { ...consent, policyVersion: await revise(owner, RW, { expiresAt: new Date(Date.now() + 1500).toISOString() }) };
  await reserveOnce(runtime, RW, RA, consent);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent)), 'AR001', 'expired');
  consent = { ...consent, policyVersion: await revise(owner, RW, { state: 'ACTIVE', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) };
});

test('unknown/crash/restart: durable liability, no automatic refund/replay/reset; a NO_DISPATCH claim later than the 10 s backstop is refused; captured version kept', async () => {
  const crashed = await connectAs(pgdb.runtimeUrl);
  const lost = await reserveOnce(crashed, RW, RA, consent);
  await crashed.end().catch(() => undefined); // the process "dies" after the committed admission, before any settlement
  const restarted = await connectAs(pgdb.runtimeUrl);
  try {
    const l1 = await ledger(owner, RW);
    assert.equal(l1.attempts.find(a => a.id === lost.attemptId)!.state, 'EGRESS_COMMITTED', 'the reservation outlives the process');
    const next = await reserveOnce(restarted, RW, RA, consent);
    const l2 = await ledger(owner, RW);
    assert.equal(sum(l2, 'DAY'), sum(l1, 'DAY') + 300_000n, 'a new attempt is new liability; nothing was reset');
    consent = { ...consent, policyVersion: await revise(owner, RW, { priceRevision: 'synthetic-price-rev-2' }) };
    await new Promise(resolve => setTimeout(resolve, 10_200)); // one deliberate wait: past the 10 s late-claim backstop
    // A bound on how LATE a zero refund may be claimed — not a proof of process continuity (see the R5 limitation test).
    assert.equal(await sqlstate(settleOnce(restarted, RW, RA, lost, 'NO_DISPATCH')), 'AR006', 'NO_DISPATCH after the 10 s backstop');
    assert.equal(await settleOnce(restarted, RW, RA, lost, 'DELIVERY_UNKNOWN'), '300000');
    assert.equal(await settleOnce(restarted, RW, RA, next, 'USAGE_VERIFIED', { promptTokens: 10, completionTokens: 1 }), '4');
    const l3 = await ledger(owner, RW);
    assert.equal(l3.attempts.find(a => a.id === next.attemptId)!.policyVersion, String(BigInt(consent.policyVersion) - 1n), 'captured version kept');
    assert.equal(await sqlstate(settleOnce(restarted, RW, RA, lost, 'DELIVERY_UNKNOWN')), 'AR006', 'UNKNOWN is terminal');
  } finally { await restarted.end().catch(() => undefined); }
  consent = { ...consent, policyVersion: await revise(owner, RW, { priceRevision: PRICE }) };
});

test('late settlement adjusts the ORIGINAL UTC periods; a new period does not erase old liability', async () => {
  const a = await reserveOnce(runtime, RW, RA, consent);
  // TEST-ONLY aging of one attempt into the previous month (user triggers briefly disabled, ledger kept consistent).
  await ownerScoped(owner, RW, async () => {
    for (const t of ['RemoteAskAttempt', 'RemoteAskPeriodCounter']) await owner.query(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    const old = (await owner.query(`SELECT "dayStart", "monthStart", "projectIdentity" FROM "RemoteAskAttempt" WHERE id = $1`, [a.attemptId])).rows[0];
    await owner.query(`UPDATE "RemoteAskAttempt" SET "createdAt" = timestamptz '2020-01-31 23:59:59.5+00', "dayStart" = '2020-01-31', "monthStart" = '2020-01-01' WHERE id = $1`, [a.attemptId]);
    await owner.query(`UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = "chargedMicroUsd" - 300000 WHERE "workspaceId" = $1 AND "projectIdentity" = $2
      AND (("kind" = 'DAY' AND "periodStart" = $3) OR ("kind" = 'MONTH' AND "periodStart" = $4))`, [RW, old.projectIdentity, old.dayStart, old.monthStart]);
    await owner.query(`INSERT INTO "RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", kind, "periodStart", "chargedMicroUsd") VALUES ($1, $2, 'DAY', '2020-01-31', 300000),
      ($1, $2, 'MONTH', '2020-01-01', 300000)`, [RW, old.projectIdentity]);
    for (const t of ['RemoteAskAttempt', 'RemoteAskPeriodCounter']) {
      await owner.query(`ALTER TABLE "${t}" ENABLE ALWAYS TRIGGER "${t}_guard", ENABLE ALWAYS TRIGGER "${t}_truncate", ENABLE ALWAYS TRIGGER "${t}_ledger"`);
    }
  });
  const before = await ledger(owner, RW);
  assert.equal(await settleOnce(runtime, RW, RA, a, 'USAGE_VERIFIED', { promptTokens: 100, completionTokens: 0 }), '28');
  const after1 = await ledger(owner, RW);
  const pick = (l: typeof before, kind: string, start: string) => l.counters.find(c => c.kind === kind && c.periodStart === start)!.charged;
  assert.deepEqual([pick(after1, 'DAY', '2020-01-31'), pick(after1, 'MONTH', '2020-01-01')], ['28', '28'], 'refund to the original periods');
  assert.deepEqual(after1.counters.filter(c => !c.periodStart.startsWith('2020')), before.counters.filter(c => !c.periodStart.startsWith('2020')), 'current periods untouched');
});

test('caps: lowering below spend refuses new admission and never rewrites history; raising back is refused; last month dollar on independent projects', async () => {
  const day = sum(await ledger(owner, RW), 'DAY') - 28n; // current UTC day (the aged 2020 attempt aside)
  assert.ok(day > 300_000n);
  consent = { ...consent, policyVersion: await revise(owner, RW, { dayCapMicroUsd: '300000' }) };
  const before = await ledger(owner, RW);
  assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, consent)), 'AR003', 'lowered day cap below spend');
  assert.deepEqual(await ledger(owner, RW), before, 'counters unchanged');
  assert.equal(await sqlstate(revise(owner, RW, { dayCapMicroUsd: '2000000' })), 'AR009', 'RC2 R1: a lowered cap is never raised back by a revision');
  assert.equal((await policyRow(owner, RW))!.dayCapMicroUsd, '300000');
  assert.equal((await policyRow(owner, RW))!.projectIdentity, policy.project, 'project identity pinned across revisions');
  // The month boundary exactly, each on an independently provisioned project (no cap is ever raised).
  const short = await freshProject(owner, 'capshort', { monthCap: '599999' });
  await reserveOnce(runtime, short.ws, short.client, short, { actor: short.actor });
  assert.equal(await sqlstate(reserveOnce(runtime, short.ws, short.client, short, { actor: short.actor })), 'AR003', 'one micro-dollar short of the month cap');
  const exact = await freshProject(owner, 'capexact', { monthCap: '600000' });
  for (let i = 0; i < 2; i++) await reserveOnce(runtime, exact.ws, exact.client, exact, { actor: exact.actor });
  assert.equal(await sqlstate(reserveOnce(runtime, exact.ws, exact.client, exact, { actor: exact.actor })), 'AR003', 'the last micro-dollar is spent');
  assert.deepEqual((await ledger(owner, exact.ws)).counters.map(c => c.charged), ['600000', '600000']);
});

test('RC2 R3: a policy that expires while reserve waits on a counter lock admits nothing — no attempt, no counter delta (DB clock, fixed AR001)', async () => {
  const p = await freshProject(owner, 'expiry');
  await reserveOnce(runtime, p.ws, p.client, p, { actor: p.actor }); // counters exist
  const expiresAt = new Date(Date.now() + 1500).toISOString();
  const consentX = { admissionId: p.admissionId, policyVersion: await revise(owner, p.ws, { expiresAt }) };
  const before = await ledger(owner, p.ws);
  const observer = await connectAs(pgdb.ownerUrl); const blocked = await connectAs(pgdb.runtimeUrl);
  try {
    const pid = (await blocked.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [p.ws]);
    await owner.query(`SELECT 1 FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND kind = 'MONTH' FOR UPDATE`, [p.ws]);
    const pending = reserveOnce(blocked, p.ws, p.client, consentX, { actor: p.actor }).then(() => 'ADMITTED', (e: { code?: string }) => String(e.code));
    await waitUntilBlocked(observer, pid); // admitted all predicates before the lock, now waiting MONTH FOR UPDATE
    await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(expiresAt).getTime() - Date.now() + 150)));
    await owner.query('COMMIT');
    assert.equal(await pending, 'AR001', 'expiry is rechecked after the blocking counter work');
  } finally { await owner.query('ROLLBACK').catch(() => undefined); await observer.end(); await blocked.end(); }
  assert.deepEqual(await ledger(owner, p.ws), before, 'no new attempt, both counters unchanged');
});

test('RC2 R5 limitation (observational): inside the window the DB cannot tell a fresh process from the original — a fresh connection’s NO_DISPATCH is accepted', async () => {
  // The routine trusts the runtime caller's outcome. Elapsed time, reconnection and persisted attempt/correlation IDs do not
  // prove process continuity or that nothing was dispatched; R-B must own a private, non-reconstructible in-process proof.
  const p = await freshProject(owner, 'fresh');
  const original = await connectAs(pgdb.runtimeUrl);
  const attempt = await reserveOnce(original, p.ws, p.client, p, { actor: p.actor });
  await original.end();
  const fresh = await connectAs(pgdb.runtimeUrl);
  try { assert.equal(await settleOnce(fresh, p.ws, p.client, attempt, 'NO_DISPATCH'), '0', 'accepted: an R-B acceptance prerequisite, not an R-A proof'); }
  finally { await fresh.end(); }
  assert.deepEqual((await ledger(owner, p.ws)).counters.map(c => c.charged), ['0', '0']);
});

test('ledger invariant and direct writes: runtime has no table/column DML; even the definer cannot desynchronize counters or go negative', async () => {
  for (const sql of [`INSERT INTO "RemoteAskPeriodCounter" ("workspaceId","projectIdentity",kind,"periodStart") VALUES ('${RW}','x','DAY','2020-01-01')`,
    `UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = 0`, `UPDATE "RemoteAskAttempt" SET state = 'SETTLED'`, `DELETE FROM "RemoteAskAttempt"`,
    `UPDATE "RemoteAskPolicy" SET state = 'ACTIVE'`, `UPDATE "RemoteAskClientAdmission" SET state = 'ADMITTED'`, `TRUNCATE "RemoteAskAttempt"`,
    `INSERT INTO "RemoteAskClientAdmission" ("workspaceId","admissionId","clientId",state,"changedAtPolicyVersion") VALUES ('${RW}', gen_random_uuid(), '${RB}', 'ADMITTED', 1)`]) {
    assert.equal(await sqlstate(ownerless(RA, () => runtime.query(sql))), '42501', sql);
  }
  assert.ok((await ownerless(RA, () => runtime.query(`SELECT count(*)::int AS n FROM "RemoteAskAttempt"`))).rows[0].n > 0, 'runtime SELECT is scoped');
  for (const t of ['RemoteAskPolicy', 'RemoteAskClientAdmission', 'RemoteAskPeriodCounter', 'RemoteAskAttempt']) {
    for (const ws of [RX, 'rem-no-such-ws', '']) {
      const n = (await ownerless(RA, async () => { await runtime.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
        return runtime.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "workspaceId" <> $1 OR $1 = ''`, [ws]); })).rows[0].n;
      assert.equal(n, 0, `FORCE RLS: ${t} rows of another workspace are invisible under '${ws}'`);
    }
  }
  const asDefiner = (sql: string) => ownerScoped(owner, RW, async () => { await owner.query(`SET LOCAL ROLE "${pgdb.remoteRole}"`); await owner.query(sql); });
  assert.equal(await sqlstate(asDefiner(`UPDATE public."RemoteAskPeriodCounter" SET "chargedMicroUsd" = "chargedMicroUsd" - 1 WHERE kind = 'DAY'`)), 'AR010');
  assert.equal(await sqlstate(asDefiner(`UPDATE public."RemoteAskPeriodCounter" SET "chargedMicroUsd" = -1 WHERE kind = 'DAY'`)), '23514');
  const open = (await ledger(owner, RW)).attempts.find(a => a.state === 'EGRESS_COMMITTED')!;
  assert.equal(await sqlstate(asDefiner(`UPDATE public."RemoteAskAttempt" SET state = 'SETTLED', outcome = 'NO_DISPATCH', "accountedMicroUsd" = 0,
    "settledAt" = clock_timestamp() WHERE id = '${open.id}'`)), '23514', 'NO_DISPATCH outside the 10 s window violates the row CHECK');
  assert.equal(await sqlstate(asDefiner(`UPDATE public."RemoteAskAttempt" SET state = 'SETTLED', outcome = 'USAGE_VERIFIED', "promptTokens" = 0,
    "completionTokens" = 0, "accountedMicroUsd" = 0, "settledAt" = clock_timestamp() WHERE id = '${open.id}'`)), 'AR010',
    'a row-consistent refund without its counter adjustment cannot commit');
  assert.equal(await sqlstate(asDefiner(`UPDATE public."RemoteAskAttempt" SET "dayStart" = '2020-01-01' WHERE id = '${open.id}'`)), '42501');
  assert.equal(await sqlstate(asDefiner(`DELETE FROM public."RemoteAskPeriodCounter"`)), '42501');
});
