import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStatusDto, assertSummaryDto, decideRead, statusDto, summaryDto } from '../packages/poweroffice/read-contracts.ts';
import type { ReadFacts, ReadView } from '../packages/poweroffice/read-contracts.ts';
import { parsePowerOfficeInvocation, runPowerOfficeCli } from '../packages/ops/poweroffice.ts';
import { runnerProblems } from '../packages/poweroffice/runner-role.ts';
import type { RunnerFacts } from '../packages/poweroffice/runner-role.ts';
import { powerOfficeRunnerUrl, openPowerOfficeRuntime } from '../packages/poweroffice/maintenance.ts';

// S4-C pure checks: 04's first-match read precedence (one case per row plus the tie-breaks), the exact DTO whitelists
// and output validation, the strict CLI argument grammar and refusals before any database work, runner-fact evaluation.
const base: ReadFacts = { binding: 'VALID', priorSuccess: false, lastCompletedState: null, lastCompletedErrorCode: null, snapshot: null };
const fresh = { expired: false, stale: false };
const decide = (f: Partial<ReadFacts>) => { const d = decideRead({ ...base, ...f }); return [d.status, d.safeErrorCode, d.visible]; };

test('04 precedence: one case per row, first match wins', () => {
  assert.deepEqual(decide({ binding: 'POWEROFFICE_CONNECTION_UNAVAILABLE', priorSuccess: true, snapshot: fresh }), ['UNAVAILABLE', 'POWEROFFICE_CONNECTION_UNAVAILABLE', false]);
  assert.deepEqual(decide({ binding: 'POWEROFFICE_BINDING_CHANGED', priorSuccess: true, snapshot: { expired: true, stale: true } }), ['UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED', false]);
  assert.deepEqual(decide({ priorSuccess: true }), ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', false], 'purged');
  assert.deepEqual(decide({ priorSuccess: true, snapshot: { expired: true, stale: true }, lastCompletedState: 'FAILED', lastCompletedErrorCode: 'POWEROFFICE_SOURCE_FAILED' }),
    ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', false], 'EXPIRED outranks a later failure');
  assert.deepEqual(decide({ priorSuccess: true, lastCompletedState: 'ABANDONED', lastCompletedErrorCode: 'POWEROFFICE_DEADLINE' }), ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', false]);
  assert.deepEqual(decide({ lastCompletedState: 'FAILED', lastCompletedErrorCode: 'POWEROFFICE_DTO_INVALID' }), ['ERROR', 'POWEROFFICE_DTO_INVALID', false]);
  assert.deepEqual(decide({ lastCompletedState: 'ABANDONED', lastCompletedErrorCode: 'POWEROFFICE_DEADLINE' }), ['ERROR', 'POWEROFFICE_DEADLINE', false]);
  assert.deepEqual(decide({}), ['MISSING', null, false]);
  assert.deepEqual(decide({ priorSuccess: true, snapshot: { expired: false, stale: true }, lastCompletedState: 'FAILED', lastCompletedErrorCode: 'POWEROFFICE_SOURCE_FAILED' }),
    ['STALE', 'POWEROFFICE_SOURCE_FAILED', true], 'failure warning outranks age');
  assert.deepEqual(decide({ priorSuccess: true, snapshot: { expired: false, stale: true }, lastCompletedState: 'SUCCEEDED' }), ['STALE', 'POWEROFFICE_SNAPSHOT_STALE', true]);
  assert.deepEqual(decide({ priorSuccess: true, snapshot: fresh, lastCompletedState: 'SUCCEEDED' }), ['FRESH', null, true]);
  assert.throws(() => decideRead({ ...base, lastCompletedState: 'FAILED', lastCompletedErrorCode: 'raw vendor text' }), { code: 'UNEXPECTED_ERROR' });
});

const SUMMARY = { totalCount: 1, currencies: [{ currency: 'NOK', count: 1, openInvoiceCount: 1, overdueInvoiceCount: 0, creditNoteCount: 0,
  outstandingInvoiceAmount: '10.00', outstandingCreditAmount: '0.00' }] };
const view = (over: Partial<ReadView> = {}): ReadView => ({ connectionId: 'po-a', decision: { status: 'FRESH', safeErrorCode: null, visible: true },
  snapshot: { asOf: '2026-10-10T08:00:00.000Z', expiresAt: '2026-10-11T08:00:01.000Z', businessDate: '2026-10-10', summary: SUMMARY },
  lastAttemptState: 'SUCCEEDED', lastAttemptId: '00000000-0000-4000-8000-000000000001', lastAttemptSequence: 1, lastCompletedState: 'SUCCEEDED',
  lastCompletedErrorCode: null, lastSuccessAt: '2026-10-10T08:00:01.000Z', ...over });

test('exact DTO whitelists and output validation: frozen, synthetic, no extra/private field, no payload outside FRESH/STALE', () => {
  const s = summaryDto(view());
  assert.deepEqual(Object.keys(s), ['connectionId', 'status', 'asOf', 'expiresAt', 'businessDate', 'summary', 'lastAttemptState', 'lastCompletedState',
    'lastCompletedErrorCode', 'safeErrorCode', 'synthetic']);
  assert.equal(Object.isFrozen(s), true); assert.equal(s.synthetic, true);
  const t = statusDto(view());
  assert.equal('summary' in t, false); assert.deepEqual([t.lastAttemptSequence, t.synthetic], [1, true]);
  const missing = summaryDto(view({ decision: { status: 'MISSING', safeErrorCode: null, visible: false }, lastAttemptState: null, lastAttemptId: null,
    lastAttemptSequence: null, lastCompletedState: null, lastSuccessAt: null }));
  assert.deepEqual([missing.summary, missing.asOf, missing.lastAttemptState], [null, null, 'NEVER_SYNCED']);
  assert.throws(() => assertSummaryDto({ ...s, companyKey: 'synthetic-po-x' }), { code: 'UNEXPECTED_ERROR' });
  assert.throws(() => assertSummaryDto({ ...s, summary: null }), { code: 'UNEXPECTED_ERROR' }, 'FRESH needs its summary');
  assert.throws(() => assertSummaryDto({ ...s, status: 'EXPIRED' }), { code: 'UNEXPECTED_ERROR' }, 'no payload when not visible');
  assert.throws(() => assertSummaryDto({ ...s, synthetic: false }), { code: 'UNEXPECTED_ERROR' });
  assert.throws(() => assertStatusDto({ ...t, summary: SUMMARY }), { code: 'UNEXPECTED_ERROR' });
  assert.throws(() => assertStatusDto({ ...t, safeErrorCode: 'free text' }), { code: 'UNEXPECTED_ERROR' });
  assert.throws(() => summaryDto(view({ snapshot: { ...view().snapshot!, summary: { ...SUMMARY, extra: 1 } } })), { code: 'UNEXPECTED_ERROR' });
  assert.throws(() => summaryDto(view({ snapshot: { ...view().snapshot!, asOf: '2026-10-10 08:00' } })), { code: 'UNEXPECTED_ERROR' });
});

test('CLI grammar: exactly --client and --connection once each; no source/file/url/token/clock flag', () => {
  assert.deepEqual(parsePowerOfficeInvocation(['poweroffice-summary', '--connection', 'po-a', '--client', 'c']), { command: 'poweroffice-summary', clientId: 'c', connectionId: 'po-a' });
  for (const argv of [['poweroffice-summary', '--client', 'c'], ['poweroffice-summary', '--client', 'c', '--client', 'd'],
    ['poweroffice-sync', '--client', 'c', '--connection', 'n', '--token', 't'], ['poweroffice-sync', '--client', 'c', '--url', 'http://x'],
    ['poweroffice-cleanup', '--client', 'c', '--connection', '--x'], ['poweroffice-status', '--client', 'c', '--connection', 'a b'],
    ['poweroffice-status', '--client=c', '--connection', 'n', 'x'], ['poweroffice-export', '--client', 'c', '--connection', 'n'], ['poweroffice-seed', '--client', 'c', '--connection', 'n']]) {
    assert.throws(() => parsePowerOfficeInvocation(argv), { code: 'INVALID_ARGUMENTS' }, argv.join(' '));
  }
});

test('CLI refusals before any database: usage, mode, credential and missing runtime are exit 2 with fixed synthetic output', async () => {
  const run = (argv: string[], env: Record<string, string>) => runPowerOfficeCli(argv, env);
  const ok = ['poweroffice-status', '--client', 'c', '--connection', 'n'];
  const token = 'atl_' + 'a'.repeat(40);
  assert.deepEqual(await run(['poweroffice-status', '--client', 'c'], {}), { code: 2, output: { command: 'poweroffice-status', safeErrorCode: 'INVALID_ARGUMENTS',
    commands: ['poweroffice-status', 'poweroffice-summary', 'poweroffice-sync', 'poweroffice-recover', 'poweroffice-cleanup'], synthetic: true } });
  assert.deepEqual(await run(ok, { ATLAS_OPERATOR_TOKEN: token }), { code: 2, output: { command: 'poweroffice-status', safeErrorCode: 'POWEROFFICE_DISABLED', synthetic: true } });
  assert.deepEqual((await run(ok, { ATLAS_POWEROFFICE_MODE: 'LIVE', ATLAS_OPERATOR_TOKEN: token })).output.safeErrorCode, 'POWEROFFICE_MODE_UNSUPPORTED');
  assert.deepEqual((await run(ok, { ATLAS_POWEROFFICE_MODE: 'MOCK', ATLAS_POWEROFFICE_URL: 'http://127.0.0.1:9', ATLAS_OPERATOR_TOKEN: token })).output.safeErrorCode,
    'POWEROFFICE_MODE_UNSUPPORTED');
  assert.deepEqual(await run(ok, { ATLAS_POWEROFFICE_MODE: 'MOCK', ATLAS_OPERATOR_TOKEN: 'short' }),
    { code: 2, output: { command: 'poweroffice-status', safeErrorCode: 'POWEROFFICE_AUTHENTICATION_FAILED', synthetic: true } });
  assert.deepEqual(await run(ok, { ATLAS_POWEROFFICE_MODE: 'MOCK', ATLAS_OPERATOR_TOKEN: token }),
    { code: 2, output: { command: 'poweroffice-status', safeErrorCode: 'POWEROFFICE_RUNTIME_NOT_READY', synthetic: true } });
});

test('runner facts and pairing: every violation is a fixed reason; runner URL resolution never echoes a URL', () => {
  const pairing = { database: 'd', started: 's', routine: '1', runner: 'r' };
  const clean: RunnerFacts = { ...pairing, superuser: false, bypassRls: false, sessionRoleMismatch: false, attributeViolations: 0, memberships: 0, members: 0,
    surfaceViolations: 0, routines: 1, routineCount: 1, executeViolations: 0, definerViolations: 0 };
  assert.deepEqual(runnerProblems(clean, pairing), []);
  assert.deepEqual(runnerProblems(undefined, pairing), ['noFacts']);
  assert.deepEqual(runnerProblems({ ...clean, superuser: true, surfaceViolations: 2 }, pairing), ['bypassesRls', 'surfaceViolations']);
  assert.deepEqual(runnerProblems(clean, { ...pairing, started: 'other' }), ['pairing.started']);
  const runtime = openPowerOfficeRuntime('postgresql://rt:pw@db.example:5432/atlas?schema=public');
  const ref = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://R' };
  assert.equal(powerOfficeRunnerUrl(runtime, { ...ref, R: 'postgresql://run:x@DB.example/atlas?schema=public' }), 'postgresql://run:x@db.example:5432/atlas?schema=public');
  for (const r of ['postgresql://run:x@db.example:5433/atlas?schema=public', 'postgresql://run:x@db.example/other?schema=public',
    'postgresql://run:x@db.example/atlas', 'postgresql://rt:x@db.example/atlas?schema=public', 'not a url']) {
    assert.throws(() => powerOfficeRunnerUrl(runtime, { ...ref, R: r }), (e: Error & { code?: string }) => e.code === 'POWEROFFICE_RUNTIME_NOT_READY' && !e.message.includes('db.example'));
  }
  assert.throws(() => powerOfficeRunnerUrl(Object.freeze({ db: runtime.db }), { ...ref, R: 'postgresql://run:x@db.example/atlas?schema=public' }), { code: 'POWEROFFICE_RUNTIME_NOT_READY' });
  void runtime.db.$disconnect();
});
