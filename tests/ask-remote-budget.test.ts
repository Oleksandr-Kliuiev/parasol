import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ASK_REMOTE_PROFILE, COMPLETION_RATE, DAY_CAP_LIMIT_MICRO_USD, MAX_POLICY_VERSION, MAX_TIME_VALUE_MS, MONTH_CAP_LIMIT_MICRO_USD, NO_DISPATCH_WINDOW_MS,
  PROMPT_RATE, RESERVE_MICRO_USD, admissionDecision, nextPolicyVersion, parsePolicyVersion, reserve, settle, settlementCost, utcPeriods, validCaps,
  validInstantMs, validUsage,
} from '../packages/ask/remote/budget.ts';
import type { PolicySnapshot } from '../packages/ask/remote/budget.ts';
import { ASK_REMOTE_SQLSTATES, ledgerErrorCode, pauseParams, reserveParams, settleParams } from '../packages/ask/remote/ledger-sql.ts';
import { ASK_REMOTE_DEFINER_COLUMN_PRIVILEGES, ASK_REMOTE_DEFINER_TABLE_PRIVILEGES, ASK_REMOTE_ROUTINES, ASK_REMOTE_TABLES } from '../packages/graph/ask-remote-role.ts';
import { PROTECTED_TABLES } from '../packages/graph/runtime-role.ts';

// ASK-REMOTE R-A pure transitions (04_AUTHORITY_AND_BILLING.md) and their parity with the SQL that enforces them durably.
const W = 'ws-remote'; const C = 'client-a'; const A = 'actor-a';
const ADM = '0f8f3c1e-8a7b-4c2d-9e1f-2a3b4c5d6e7f'; const COR = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

test('fixed profile constants: reserve covers the full-window worst case, rounded up; caps are the proposed upper bounds', () => {
  // 1,050,000 × US$0.275/MTok + 512 × US$0.825/MTok = US$0.2891724 → 289172.4 micro-USD ≤ 300000
  assert.ok(1_050_000n * PROMPT_RATE + 512n * COMPLETION_RATE <= RESERVE_MICRO_USD * 1000n);
  assert.equal(RESERVE_MICRO_USD, 300_000n);
  assert.deepEqual([PROMPT_RATE, COMPLETION_RATE, DAY_CAP_LIMIT_MICRO_USD, MONTH_CAP_LIMIT_MICRO_USD], [275n, 825n, 2_000_000n, 10_000_000n]);
  assert.equal(ASK_REMOTE_PROFILE, 'ask-remote-openai-luna-v1');
});

test('policyVersion: canonical positive decimal ≤ max bigint only; +1 exactly; max is a terminal tombstone; never Number', () => {
  for (const ok of ['1', '42', '9223372036854775807']) assert.equal(parsePolicyVersion(ok), BigInt(ok));
  for (const bad of ['0', '-1', '01', '+1', '1.0', '1e3', ' 1', '9223372036854775808', '99999999999999999999', 1, 1n, null, '']) {
    assert.equal(parsePolicyVersion(bad), null, String(bad));
  }
  assert.deepEqual(nextPolicyVersion(1n), { version: 2n, tombstone: false });
  assert.deepEqual(nextPolicyVersion(MAX_POLICY_VERSION - 1n), { version: MAX_POLICY_VERSION, tombstone: true });
  assert.throws(() => nextPolicyVersion(MAX_POLICY_VERSION), /VERSION_EXHAUSTED/);
  assert.throws(() => nextPolicyVersion(0n), /VERSION_EXHAUSTED/);
});

test('UTC period keys ignore the local time zone and switch exactly at UTC midnight / month start', () => {
  assert.deepEqual(utcPeriods(new Date('2026-10-31T23:59:59.999Z')), { day: '2026-10-31', month: '2026-10-01' });
  assert.deepEqual(utcPeriods(new Date('2026-11-01T00:00:00.000Z')), { day: '2026-11-01', month: '2026-11-01' });
  // The same instant written with an offset is the same UTC period (Europe/Oslo local date would already be Nov 1).
  assert.deepEqual(utcPeriods(new Date('2026-11-01T00:30:00+01:00')), { day: '2026-10-31', month: '2026-10-01' });
  assert.deepEqual(utcPeriods(new Date('2028-02-29T12:00:00Z')), { day: '2028-02-29', month: '2028-02-01' });
  assert.throws(() => utcPeriods(new Date('invalid')));
});

test('reserve: last dollar of month and day exactly; one micro-dollar short refuses; both or neither; lowered cap below spend refuses', () => {
  const caps = { month: 10_000_000n, day: 2_000_000n };
  assert.deepEqual(reserve({ month: 9_700_000n, day: 0n }, caps), { admitted: true, counters: { month: 10_000_000n, day: 300_000n } });
  assert.deepEqual(reserve({ month: 9_700_001n, day: 0n }, caps), { admitted: false, code: 'ASK_REMOTE_BUDGET' });
  assert.deepEqual(reserve({ month: 0n, day: 1_700_000n }, caps), { admitted: true, counters: { month: 300_000n, day: 2_000_000n } });
  assert.deepEqual(reserve({ month: 0n, day: 1_700_001n }, caps), { admitted: false, code: 'ASK_REMOTE_BUDGET' });
  assert.deepEqual(reserve({ month: 1_500_000n, day: 1_500_000n }, { month: 1_000_000n, day: 1_000_000n }), { admitted: false, code: 'ASK_REMOTE_BUDGET' });
  assert.deepEqual(reserve({ month: 0n, day: 0n }, { month: 299_999n, day: 2_000_000n }), { admitted: false, code: 'ASK_REMOTE_BUDGET' });
  assert.throws(() => reserve({ month: 0n, day: 0n }, { month: 10_000_001n, day: 0n }), /invalid/);
  assert.throws(() => reserve({ month: -1n, day: 0n }, caps), /invalid/);
  assert.equal(validCaps(2_000_000n, 10_000_000n), true); assert.equal(validCaps(2_000_001n, 0n), false); assert.equal(validCaps(-1n, 0n), false);
});

test('settlement cost: integer ceil of validated usage only; bounds; never above the reserve', () => {
  assert.equal(settlementCost({ promptTokens: 0, completionTokens: 0 }), 0n);
  assert.equal(settlementCost({ promptTokens: 1, completionTokens: 0 }), 1n); // 0.275 → 1
  assert.equal(settlementCost({ promptTokens: 4, completionTokens: 0 }), 2n); // 1.1 → 2
  assert.equal(settlementCost({ promptTokens: 1000, completionTokens: 0 }), 275n);
  assert.equal(settlementCost({ promptTokens: 1000, completionTokens: 1000 - 488 }), 275n + 423n); // 512 × 0.825 = 422.4 → 698 total ceil
  assert.equal(settlementCost({ promptTokens: 32768, completionTokens: 512 }), 9434n);
  for (const bad of [{ promptTokens: 32769, completionTokens: 0 }, { promptTokens: 0, completionTokens: 513 }, { promptTokens: -1, completionTokens: 0 },
    { promptTokens: 1.5, completionTokens: 0 }, { promptTokens: Number.NaN, completionTokens: 0 }, { promptTokens: '1', completionTokens: 0 }, null]) {
    assert.equal(validUsage(bad), false, JSON.stringify(bad));
    assert.throws(() => settlementCost(bad as never), /USAGE_INVALID/);
  }
});

test('settle: exactly once; usage → ceil; caller-asserted NO_DISPATCH 0 only within the window; everything else keeps the reserve', () => {
  const open = { state: 'EGRESS_COMMITTED' as const, reservedMicroUsd: RESERVE_MICRO_USD, createdAtMs: 1_000_000 };
  assert.deepEqual(settle(open, 'USAGE_VERIFIED', { promptTokens: 1200, completionTokens: 40 }, 1_000_500),
    { settled: true, state: 'SETTLED', accountedMicroUsd: 363n, refundMicroUsd: 299_637n });
  assert.deepEqual(settle(open, 'NO_DISPATCH', null, 1_000_000 + NO_DISPATCH_WINDOW_MS),
    { settled: true, state: 'SETTLED', accountedMicroUsd: 0n, refundMicroUsd: 300_000n });
  // The window bounds how LATE a zero refund may be claimed; it is not a proof of process continuity or of no dispatch.
  assert.equal(settle(open, 'NO_DISPATCH', null, 1_000_001 + NO_DISPATCH_WINDOW_MS).settled, false, 'later than the window: refused');
  for (const outcome of ['DELIVERY_UNKNOWN', 'USAGE_INVALID', 'MODEL_MISMATCH', 'UPSTREAM_REJECTED'] as const) {
    assert.deepEqual(settle(open, outcome, null, 1_000_100), { settled: true, state: 'UNKNOWN', accountedMicroUsd: 300_000n, refundMicroUsd: 0n });
    assert.equal(settle(open, outcome, { promptTokens: 1, completionTokens: 1 }, 1_000_100).settled, false, 'usage only with USAGE_VERIFIED');
  }
  assert.equal(settle(open, 'USAGE_VERIFIED', null, 1_000_100).settled, false);
  assert.equal(settle(open, 'USAGE_VERIFIED', { promptTokens: 40000, completionTokens: 0 }, 1_000_100).settled, false);
  for (const state of ['SETTLED', 'UNKNOWN'] as const) assert.equal(settle({ ...open, state }, 'NO_DISPATCH', null, 1_000_100).settled, false, 'no second settlement');
  assert.equal(settle({ ...open, reservedMicroUsd: 1n }, 'DELIVERY_UNKNOWN', null, 1_000_100).settled, false);
  assert.equal(settle(open, 'REFUND' as never, null, 1_000_100).settled, false);
});

test('admission decision order: stale consent tuple first (POLICY_CHANGED), then active/expiry/profile/price/client (NOT_ADMITTED)', () => {
  const policy: PolicySnapshot = { admissionId: ADM, policyVersion: 7n, state: 'ACTIVE', expiresAtMs: 2_000, profile: ASK_REMOTE_PROFILE,
    priceRevision: 'openai-luna-eu-2026-10', reserveMicroUsd: RESERVE_MICRO_USD, clientAdmitted: true };
  const expected = { profile: ASK_REMOTE_PROFILE, priceRevision: 'openai-luna-eu-2026-10' };
  const consent = { admissionId: ADM, policyVersion: 7n };
  assert.equal(admissionDecision(policy, consent, expected, 1_999), 'ADMITTED');
  assert.equal(admissionDecision(null, consent, expected, 1), 'ASK_REMOTE_NOT_ADMITTED');
  assert.equal(admissionDecision(policy, { ...consent, policyVersion: 6n }, expected, 1), 'ASK_REMOTE_POLICY_CHANGED');
  assert.equal(admissionDecision({ ...policy, state: 'PAUSED' }, { ...consent, policyVersion: 6n }, expected, 1), 'ASK_REMOTE_POLICY_CHANGED',
    'a stale tuple is reported as changed even when the policy is also inactive');
  assert.equal(admissionDecision(policy, { ...consent, admissionId: COR }, expected, 1), 'ASK_REMOTE_POLICY_CHANGED');
  for (const broken of [{ state: 'PAUSED' }, { state: 'REVOKED' }, { state: 'INACTIVE' }, { state: 'TOMBSTONE' }, { expiresAtMs: 1 },
    { priceRevision: 'other-price' }, { profile: 'other' }, { clientAdmitted: false }, { reserveMicroUsd: 1n }] as Partial<PolicySnapshot>[]) {
    assert.equal(admissionDecision({ ...policy, ...broken }, consent, expected, 1_500), 'ASK_REMOTE_NOT_ADMITTED', JSON.stringify(broken, (_k, v) => typeof v === 'bigint' ? String(v) : v));
  }
  assert.equal(admissionDecision(policy, consent, expected, 2_000), 'ASK_REMOTE_NOT_ADMITTED', 'expiry is exclusive');
});

test('ledger helper parameters are strictly validated; profile is compiled in; SQLSTATEs map to fixed codes only', () => {
  const r = { workspaceId: W, clientId: C, actorId: A, admissionId: ADM, policyVersion: '9223372036854775807', fenceVersion: 3,
    priceRevision: 'openai-luna-eu-2026-10', correlationId: COR };
  assert.deepEqual(reserveParams(r), [W, C, A, ADM, '9223372036854775807', 3, ASK_REMOTE_PROFILE, 'openai-luna-eu-2026-10', COR]);
  for (const bad of [{ policyVersion: '0' }, { policyVersion: '9223372036854775808' }, { fenceVersion: -1 }, { fenceVersion: 2 ** 31 }, { admissionId: ADM.toUpperCase() },
    { correlationId: 'not-a-uuid' }, { clientId: 'a,b' }, { workspaceId: '' }, { priceRevision: 'x' }]) {
    assert.throws(() => reserveParams({ ...r, ...bad }), /ARGUMENT_INVALID/, JSON.stringify(bad));
  }
  const s = { workspaceId: W, clientId: C, attemptId: ADM, correlationId: COR };
  assert.deepEqual(settleParams({ ...s, outcome: 'USAGE_VERIFIED', usage: { promptTokens: 5, completionTokens: 6 } }), [W, C, ADM, COR, 'USAGE_VERIFIED', 5, 6]);
  assert.deepEqual(settleParams({ ...s, outcome: 'DELIVERY_UNKNOWN', usage: null }), [W, C, ADM, COR, 'DELIVERY_UNKNOWN', null, null]);
  assert.throws(() => settleParams({ ...s, outcome: 'USAGE_VERIFIED', usage: null }), /ARGUMENT_INVALID/);
  assert.throws(() => settleParams({ ...s, outcome: 'NO_DISPATCH', usage: { promptTokens: 0, completionTokens: 0 } }), /ARGUMENT_INVALID/);
  assert.deepEqual(pauseParams({ workspaceId: W, admissionId: ADM, reason: 'MODEL_MISMATCH' }), [W, ADM, 'MODEL_MISMATCH']);
  assert.throws(() => pauseParams({ workspaceId: W, admissionId: ADM, reason: 'OWNER' as never }), /ARGUMENT_INVALID/);
  assert.equal(ledgerErrorCode({ code: 'AR003' }), 'ASK_REMOTE_BUDGET');
  assert.equal(ledgerErrorCode({ code: '23505' }), null);
  assert.equal(ledgerErrorCode({ code: 'toString' }), null);
  assert.equal(ledgerErrorCode(null), null);
  assert.equal(Object.keys(ASK_REMOTE_SQLSTATES).length, 10);
});

test('SQL parity: migrations, prisma/roles.sql allowlists and readiness constants agree; the four tables are protected', async () => {
  const state = await readFile(new URL('../prisma/migrations/202610111010_stage5_ask_remote_state/migration.sql', import.meta.url), 'utf8');
  const routines = await readFile(new URL('../prisma/migrations/202610111020_stage5_ask_remote_routines/migration.sql', import.meta.url), 'utf8');
  const roles = await readFile(new URL('../prisma/roles.sql', import.meta.url), 'utf8');
  for (const literal of ['"reserveMicroUsd" = 300000', '"promptRate" = 275 AND "completionRate" = 825', '"dayCapMicroUsd" BETWEEN 0 AND 2000000',
    '"monthCapMicroUsd" BETWEEN 0 AND 10000000', '"promptTokens" BETWEEN 0 AND 32768 AND "completionTokens" BETWEEN 0 AND 512',
    `"profile" = '${ASK_REMOTE_PROFILE}'`, "interval '10 seconds'", '9223372036854775807']) {
    assert.ok(state.includes(literal), literal);
  }
  assert.ok(routines.includes('v_reserve constant bigint := 300000;') && routines.includes('* v_attempt."promptRate" + p_completion_tokens::bigint * v_attempt."completionRate" + 999) / 1000'));
  for (const [name] of ASK_REMOTE_ROUTINES) assert.ok(roles.includes(`'${name}'`), name);
  const tableAllow = /v_ar_def_table TEXT\[\] := ARRAY\[([^\]]*)\];/.exec(roles)?.[1];
  const columnAllow = /v_ar_def_column TEXT\[\] := ARRAY\[([^\]]*)\];/.exec(roles)?.[1];
  const items = (block: string | undefined) => [...(block ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]!).sort();
  assert.deepEqual(items(tableAllow), Object.entries(ASK_REMOTE_DEFINER_TABLE_PRIVILEGES).flatMap(([t, ps]) => ps.map(p => `${t}:${p}`)).sort());
  assert.deepEqual(items(columnAllow), Object.entries(ASK_REMOTE_DEFINER_COLUMN_PRIVILEGES)
    .flatMap(([t, byPriv]) => Object.entries(byPriv).flatMap(([p, cols]) => cols.map(c => `${t}:${p}:${c}`))).sort());
  for (const table of ASK_REMOTE_TABLES) assert.ok(PROTECTED_TABLES.includes(table), table);
});

test('RC2 R4: instants are validated; nonfinite/fractional/out-of-range/reversed times fail closed; exact window bounds; money unchanged', () => {
  const NaNDate = new Date('not a date').getTime();
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, NaNDate, 1.5, MAX_TIME_VALUE_MS + 1, -MAX_TIME_VALUE_MS - 1,
    Number.MAX_SAFE_INTEGER, '1000' as unknown as number, null as unknown as number];
  for (const v of bad) assert.equal(validInstantMs(v), false, String(v));
  for (const v of [0, -1, 1_000_000, MAX_TIME_VALUE_MS, -MAX_TIME_VALUE_MS, new Date('2026-10-11T00:00:00Z').getTime()]) assert.equal(validInstantMs(v), true, String(v));
  // Admission: an invalid expiry or clock never admits (RC1 admitted expiresAtMs = NaN).
  const policy: PolicySnapshot = { admissionId: ADM, policyVersion: 3n, state: 'ACTIVE', expiresAtMs: 5_000, profile: ASK_REMOTE_PROFILE,
    priceRevision: 'p-rev', reserveMicroUsd: RESERVE_MICRO_USD, clientAdmitted: true };
  const consent = { admissionId: ADM, policyVersion: 3n }; const expected = { profile: ASK_REMOTE_PROFILE, priceRevision: 'p-rev' };
  assert.equal(admissionDecision(policy, consent, expected, 4_999), 'ADMITTED');
  for (const v of bad) {
    assert.equal(admissionDecision({ ...policy, expiresAtMs: v }, consent, expected, 100), 'ASK_REMOTE_NOT_ADMITTED', `expiry ${String(v)}`);
    assert.equal(admissionDecision(policy, consent, expected, v), 'ASK_REMOTE_NOT_ADMITTED', `now ${String(v)}`);
  }
  // Settlement: invalid creation/now or now before creation refuses EVERY outcome (SQL: settledAt >= createdAt).
  const open = (createdAtMs: number) => ({ state: 'EGRESS_COMMITTED' as const, reservedMicroUsd: RESERVE_MICRO_USD, createdAtMs });
  const outcomes = [['NO_DISPATCH', null], ['DELIVERY_UNKNOWN', null], ['USAGE_VERIFIED', { promptTokens: 1, completionTokens: 1 }]] as const;
  for (const [outcome, usage] of outcomes) {
    for (const v of bad) {
      assert.equal(settle(open(v), outcome, usage, 100).settled, false, `${outcome} created ${String(v)}`);
      assert.equal(settle(open(100), outcome, usage, v).settled, false, `${outcome} now ${String(v)}`);
    }
    assert.equal(settle(open(1_000), outcome, usage, 999).settled, false, `${outcome}: reversed chronology`);
    assert.equal(settle(open(1_000), outcome, usage, 1_000).settled, true, `${outcome}: now = creation`);
  }
  // Exact NO_DISPATCH bounds, also at the ends of the time-value range (BigInt difference: no overflow or rounding).
  assert.equal(settle(open(1_000), 'NO_DISPATCH', null, 1_000 + NO_DISPATCH_WINDOW_MS).settled, true);
  assert.equal(settle(open(1_000), 'NO_DISPATCH', null, 1_001 + NO_DISPATCH_WINDOW_MS).settled, false);
  assert.equal(settle(open(MAX_TIME_VALUE_MS - NO_DISPATCH_WINDOW_MS), 'NO_DISPATCH', null, MAX_TIME_VALUE_MS).settled, true);
  assert.equal(settle(open(-MAX_TIME_VALUE_MS), 'NO_DISPATCH', null, MAX_TIME_VALUE_MS).settled, false, 'huge span refused exactly');
  assert.equal(settle(open(-MAX_TIME_VALUE_MS), 'NO_DISPATCH', null, -MAX_TIME_VALUE_MS + NO_DISPATCH_WINDOW_MS).settled, true);
  // Integer money behavior is unchanged by the time validation.
  assert.deepEqual(settle(open(0), 'USAGE_VERIFIED', { promptTokens: 1200, completionTokens: 40 }, 1),
    { settled: true, state: 'SETTLED', accountedMicroUsd: 363n, refundMicroUsd: 299_637n });
  assert.deepEqual(settle(open(0), 'MODEL_MISMATCH', null, 1), { settled: true, state: 'UNKNOWN', accountedMicroUsd: 300_000n, refundMicroUsd: 0n });
});
