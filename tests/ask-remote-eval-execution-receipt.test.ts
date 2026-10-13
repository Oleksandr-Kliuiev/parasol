import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityV2 } from '../packages/ask/remote/contracts.ts';
import { admissionBlockers } from '../scripts/ask-remote-eval-execution/artifact.ts';
import { fakeUuid } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { assertReceipt, buildReceipt, lockRun, writeReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { loadContext, playNext, rig } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import { checkCapability } from '../scripts/ask-remote-eval-execution/transient.ts';
import { ExecError, ledgerValues } from '../scripts/ask-remote-eval-execution/validate.ts';

// Safe receipt (exact allowlist schema + accepted offline scan), fixed-code validators, capability classification,
// run lock and the explicit live-admission refusal. Everything here is SIMULATED/local.

const ctx = loadContext();
const sample = (): Record<string, any> => { const r = rig(ctx); playNext(r); playNext(r); return buildReceipt(r.session, ctx.cases) as Record<string, any>; };
const unsafe = (e: unknown): boolean => e instanceof ExecError && e.code === 'RECEIPT_UNSAFE' && e.message === 'RECEIPT_UNSAFE';

test('receipt: live admission is always BLOCKED with named missing contracts; no flag or field can mark it admitted', () => {
  const r = sample();
  assert.equal(r.liveAcceptanceEligible, false); assert.equal(r.liveAdmissionReadiness, 'BLOCKED');
  for (const b of ['HUMAN_LABEL_ATTESTATION_PENDING', 'OWNER_DATA_BUDGET_ADMISSION_ABSENT', 'LEDGER_METADATA_READ_CONTRACT_MISSING', 'CLOSURE_RECEIPT_READ_CONTRACT_MISSING',
    'FIXTURE_DB_PROVISIONING_CONTRACT_MISSING', 'TRANSIENT_RESPONSE_HANDOFF_CONTRACT_MISSING', 'PRIVACY_SCAN_NOT_MEASURED']) assert.ok(r.admissionBlockers.includes(b), b);
  assert.ok(admissionBlockers({ ...ctx.snapshot, labelStatus: 'HUMAN_ATTESTED', attestation: 'HUMAN_ATTESTATION_ACCEPTED' }).length >= 10);
  for (const row of Object.values(r.safety.rows) as { countsAsVerifiedZero: boolean }[]) assert.equal(row.countsAsVerifiedZero, false);
  for (const flip of [{ liveAcceptanceEligible: true }, { liveAdmissionReadiness: 'READY' }, { admissionBlockers: [] as string[] },
    { admissionBlockers: ['HUMAN_LABEL_ATTESTATION_PENDING'] }]) assert.throws(() => assertReceipt({ ...r, ...flip }, ctx.cases), unsafe);
});

test('receipt: exact allowlist rejects extra keys, foreign enums, free text and question/rationale text — without echo', () => {
  const r = sample(); const q = ctx.cases[0]!.question; const rationale = ctx.cases[3]!.rationale;
  const mutations: ((x: Record<string, any>) => void)[] = [
    x => { x.note = 'free text'; }, x => { x.cases[0].observedIntent = 'SUMMARY'; }, x => { x.cases[0].outcome = 'ASK_‮EVIL'; },
    x => { x.cases[0].outcome = q; }, x => { x.run.reason = rationale; }, x => { x.cases[0].correlationId = 'not-a-uuid'; },
    x => { x.cases[0].durationMs = -1; }, x => { x.cases[0].durationMs = 1.5; }, x => { x.admission.openingFenceEpoch = '040'; },
    x => { x.artifact.adminDeltaPaths = ['/etc/passwd']; }, x => { x.safety.rows.CLAIMS.evidence = 'VERIFIED'; }, x => { x.cases[0].truth.extra = true; },
    x => { x.provenance.transient = 'LIVE_VERIFIED'; }, x => { x.run.supportedPass.SUPPORTED_SUMMARY = 26; }, x => { x.unverified = []; },
    x => { x.cases.push({ ...x.cases[0], question: q }); }
  ];
  for (const m of mutations) {
    const copy = JSON.parse(JSON.stringify(r)) as Record<string, any>; m(copy);
    assert.throws(() => assertReceipt(copy, ctx.cases), (e: unknown) => unsafe(e) && !(e as Error).message.includes(q.slice(0, 10)));
  }
  assert.doesNotThrow(() => assertReceipt(JSON.parse(JSON.stringify(r)), ctx.cases));
});

test('run lock is exclusive per admission; the written receipt is exactly the validated safe JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-exec-'));
  try {
    const admissionId = fakeUuid('lock-test');
    lockRun(dir, admissionId);
    assert.throws(() => lockRun(dir, admissionId), (e: unknown) => e instanceof ExecError && e.code === 'RUN_ALREADY_STARTED_OR_DIR_UNWRITABLE');
    assert.throws(() => lockRun(dir, '../x'), (e: unknown) => e instanceof ExecError && e.code === 'ADMISSION_ID_INVALID');
    const r = sample();
    writeReceipt(dir, r, ctx.cases, 'REVAL_EXECUTION_TEST.json');
    writeReceipt(dir, r, ctx.cases, 'REVAL_EXECUTION_TEST.json');
    assert.throws(() => writeReceipt(dir, r, ctx.cases, '../escape.json'), (e: unknown) => e instanceof ExecError && e.code === 'RECEIPT_NAME_INVALID');
    assert.throws(() => writeReceipt(dir, { ...r, extra: 1 }, ctx.cases, 'X.json'), unsafe);
    assert.deepEqual(readdirSync(dir).sort(), ['REVAL_EXECUTION_TEST.json', `REVAL_EXECUTION_${admissionId}.lock`].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'REVAL_EXECUTION_TEST.json'), 'utf8')), r);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ledger metadata: internally inconsistent or non-canonical values are refused with one fixed code', () => {
  const caps = { day: 2_000_000, month: 10_000_000 };
  const ok = { correlationId: fakeUuid('c'), attempts: '1', settlement: 'CONFIRMED', chargedMicro: '337', dayChargedMicro: '337', monthChargedMicro: '337' };
  assert.equal(ledgerValues(ok, caps).settlement, 'CONFIRMED');
  for (const patch of [{ settlement: 'SETTLED' }, { chargedMicro: '9435' }, { settlement: 'RETAINED_KNOWN' }, { settlement: 'NO_DISPATCH' },
    { settlement: 'NO_RESERVATION' }, { attempts: '0' }, { correlationId: 'C0FFEE' }, { chargedMicro: '1e2' }, { dayChargedMicro: '338', monthChargedMicro: '337' }]) {
    assert.throws(() => ledgerValues({ ...ok, ...patch }, caps), (e: unknown) => e instanceof ExecError && e.code.startsWith('LEDGER_INVALID') || (e as ExecError).code === 'COUNTERS_INCONSISTENT');
  }
  assert.equal(ledgerValues({ ...ok, settlement: 'RETAINED_KNOWN', chargedMicro: '300000', dayChargedMicro: '300000', monthChargedMicro: '300000' }, caps).chargedMicro, 300_000);
  assert.equal(ledgerValues({ ...ok, settlement: 'NO_RESERVATION', attempts: '0', chargedMicro: '0' }, caps).attempts, 0);
});

test('capability observation: exact V2 → ACTIVE tuple; 503 ASK_REMOTE_NOT_ADMITTED → INACTIVE; anything else → UNAVAILABLE', () => {
  const corr = fakeUuid('cap');
  const body = capabilityV2(fakeUuid('adm'), '12');
  assert.deepEqual(checkCapability({ status: '200', correlationHeader: corr, body: JSON.stringify(body) }), { kind: 'ACTIVE', tuple: { admissionId: fakeUuid('adm'), policyVersion: '12' }, correlationId: corr });
  const error = (code: string) => JSON.stringify({ contractVersion: 'AskErrorV1', code, correlationId: corr });
  assert.deepEqual(checkCapability({ status: '503', correlationHeader: corr, body: error('ASK_REMOTE_NOT_ADMITTED') }), { kind: 'INACTIVE', correlationId: corr });
  assert.deepEqual(checkCapability({ status: '503', correlationHeader: corr, body: error('ASK_REMOTE_UNAVAILABLE') }), { kind: 'UNAVAILABLE' });
  assert.deepEqual(checkCapability({ status: '503', correlationHeader: fakeUuid('other'), body: error('ASK_REMOTE_NOT_ADMITTED') }), { kind: 'UNAVAILABLE' });
  assert.deepEqual(checkCapability({ status: '200', correlationHeader: corr, body: JSON.stringify({ ...body, extra: 1 }) }), { kind: 'UNAVAILABLE' });
  assert.deepEqual(checkCapability({ status: '200', correlationHeader: corr, body: JSON.stringify({ ...body, disclosure: { ...body.disclosure, policyVersion: 12 } }) }), { kind: 'UNAVAILABLE' });
  assert.throws(() => checkCapability({ status: '200', correlationHeader: corr, body: '{"contractVersion":"AskCapabilityV2","contractVersion":"x"}' }),
    (e: unknown) => e instanceof ExecError && e.code === 'PASTE_REJECTED');
  assert.throws(() => checkCapability({ status: '2OO', correlationHeader: corr, body: '{}' }), (e: unknown) => e instanceof ExecError && e.code === 'HTTP_STATUS_INVALID');
});
