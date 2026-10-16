import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../../packages/auth/token.ts';
import { RECOVERY_GRACE_MS } from '../../packages/actions/contracts.ts';
import { takeReservationPermit } from '../../packages/actions/reservation.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import { createTestDatabase, projectRoot } from '../support/pg-harness.ts';
import { CA, CUSTOMER_CANARY, addActionFixtures, privateDir, runtimeClient, tokens } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, untilPassed } from '../support/action-approval.ts';
import { addExecutionActors, candidateFile, freshCall, observeExec, writePrivate } from '../support/action-exec.ts';

// Stage 3 S3-C, C1/C7/C8 through actual `scripts/ops.ts` child processes: DISABLED by default, LIVE/origin/port refusal,
// strict flags, the whole operator journey to VERIFIED with each step authorized by its own bearer, then crash recovery and
// protected reconciliation — all outputs synthetic:true with no title/body/customer/ticket/token/path, and a TEST-ONLY
// preload that records any native network attempt of the child (none may occur).
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
await addApprovalActors(pgdb.owner);
await addExecutionActors(pgdb.owner);
const see = observeExec(runtime);
const trapFile = join(files.dir, 'network-trap.log');
const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined
  && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_|M365_|DATABASE_URL)/.test(e[0])));
interface Run { code: number | null; output: Record<string, any>; text: string }
function cli(actor: string | null, args: string[], extra: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = { ...inherited, ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_TOKEN: actor ? tokens[actor]! : '', ATLAS_ACTIONS_MODE: 'MOCK',
      ATLAS_TEST_NETWORK_TRAP_FILE: trapFile, ...extra };
    const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './tests/support/action-network-trap.ts', 'scripts/ops.ts', ...args],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('exit', code => {
      clearTimeout(timer);
      let output: Record<string, any>;
      try { output = JSON.parse(stdout) as Record<string, any>; } catch { reject(new Error(`ops ${args[0]} printed no JSON (exit ${code})`)); return; }
      // Every action envelope — success, refusal, usage or configuration failure — carries the synthetic marker
      if (output.synthetic !== true) { reject(new Error(`ops ${args[0]} envelope without synthetic:true (exit ${code})`)); return; }
      resolve({ code, output, text: stdout + stderr });
    });
  });
}
const secrets = (): string[] => [CUSTOMER_CANARY, 'CANARY', files.dir, 'tok-', 'fixture://', ...Object.values(tokens)];
function assertPrivate(run: Run, label: string, extra: string[] = []): void {
  for (const s of [...secrets(), ...extra]) assert.ok(!run.text.includes(s), `${label}: private material printed`);
}

test('C8/C7: DISABLED by default; LIVE, origin and port settings refuse; strict flags; an unknown bearer is ACTION_AUTHENTICATION_FAILED', async () => {
  const id = randomUUID();
  const cases: [string[], Record<string, string>, string | null, Record<string, unknown>][] = [
    [['action-get', '--client', CA, '--request', id], { ATLAS_ACTIONS_MODE: '' }, 'reader', { safeErrorCode: 'ACTION_MODE_DISABLED' }],
    [['action-get', '--client', CA, '--request', id], { ATLAS_ACTIONS_MODE: 'LIVE' }, 'reader', { safeErrorCode: 'ACTION_MODE_REFUSED' }],
    [['action-get', '--client', CA, '--request', id], { ATLAS_ACTIONS_ORIGIN: 'https://example.invalid' }, 'reader', { safeErrorCode: 'ACTION_MODE_REFUSED' }],
    [['action-execute', '--client', CA, '--request', id, '--hash', '0'.repeat(64)], { ATLAS_ACTIONS_PORT: 'custom' }, 'executor', { safeErrorCode: 'ACTION_MODE_REFUSED' }],
    [['action-get', '--client', CA, '--request', id], { ATLAS_OPERATOR_TOKEN: generateToken() }, null, { safeErrorCode: 'ACTION_AUTHENTICATION_FAILED' }],
    [['action-get', '--client', CA, '--request', id], { ATLAS_OPERATOR_TOKEN: 'not-a-token' }, null, { safeErrorCode: 'ACTION_AUTHENTICATION_FAILED' }],
    [['action-verify', '--client', CA, '--request', id, '--candidate', 'T-1'], {}, 'executor', { error: 'INVALID_ARGUMENTS' }],
    [['action-get', '--request', id], {}, 'reader', { error: 'INVALID_ARGUMENTS' }],
    [['action-get', '--client', CA, '--request', id, '--request', id], {}, 'reader', { error: 'INVALID_ARGUMENTS' }],
    [['action-list', '--client', CA, '--limit', '101'], {}, 'reader', { safeErrorCode: 'ACTION_INPUT_INVALID' }],
    [['action-get'], {}, 'reader', { error: 'INVALID_ARGUMENTS' }],
    [['action-get', '--client', CA, '--request', id], { ATLAS_RUNTIME_DATABASE_URL: '' }, 'reader', { error: 'ATLAS_RUNTIME_DATABASE_URL is required' }],
  ];
  for (const [args, env, actor, expected] of cases) {
    const run = await cli(actor, args, env);
    assert.equal(run.code, 2, args.join(' '));
    for (const [key, value] of Object.entries(expected)) assert.equal(run.output[key], value, `${args[0]} ${JSON.stringify(Object.keys(env))}`);
    assertPrivate(run, args[0]!);
  }
  assert.equal(existsSync(trapFile) ? readFileSync(trapFile, 'utf8') : '', '', 'no native network attempt');
  // Control: the same preload in a child that does attempt network access records it (so an empty file is meaningful)
  const controlFile = join(files.dir, 'network-trap-control.log');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './tests/support/action-network-trap.ts', '--input-type=module', '-e',
      `try { await fetch('http://127.0.0.1:9/'); } catch {} try { (await import('node:net')).default.connect(9, '127.0.0.1'); } catch {}`],
      { cwd: projectRoot, stdio: 'ignore', env: { ...inherited, ATLAS_TEST_NETWORK_TRAP_FILE: controlFile } });
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`control exited ${code}`))));
  });
  assert.deepEqual(readFileSync(controlFile, 'utf8').trim().split('\n'), ['fetch', 'net.connect']);
});

test('C1/C7: the actual CLI journey — preview, request, stored-preview approval, execute → VERIFIED; then crash recovery and protected reconciliation', async () => {
  // Started first so its 35 s recovery grace runs during the journey: the process "died" after its create committed.
  const flow = actionFlow(db, files);
  const crashed = await flow.approved();
  const reserved = await flow.reserve(crashed);
  const use = takeReservationPermit(reserved.permit, reserved.expected);
  assert.ok('dispatch' in use);
  const d = use.dispatch;
  const crashedTicket = await mockActionPorts(db).ticketPort({ workspaceId: d.workspaceId, clientId: d.clientId, connectionId: d.connectionId })
    .createOne({ customerKey: d.customerKey, markedTitle: d.markedTitle, description: d.description, nonce: d.createNonce }, freshCall());
  const notDue = await cli('executor', ['action-recover', '--client', CA, '--request', crashed.requestId]);
  assert.deepEqual([notDue.code, notDue.output.safeErrorCode], [2, 'ACTION_RECOVERY_NOT_DUE']);

  const input = await files.input({ connectionId: 'atera-a', title: 'CANARY-cli title', description: 'CANARY-cli body\nsecond line', idempotencyKey: randomUUID() });
  const inputPreview = files.out('cli-input-preview.json');
  const preview = await cli('requester', ['action-preview', '--client', CA, '--input', input, '--preview-file', inputPreview]);
  assert.deepEqual([preview.code, preview.output.idempotent, preview.output.synthetic], [0, false, true]);
  assert.equal((await stat(inputPreview)).mode & 0o777, 0o600);
  const hash = preview.output.inputHash as string; const requestId = preview.output.requestId as string;
  const request = await cli('requester', ['action-request', '--client', CA, '--input', input, '--hash', hash]);
  assert.deepEqual([request.code, request.output.state, request.output.requestId], [0, 'AWAITING_APPROVAL', requestId]);
  const stored = files.out('cli-stored-preview.json');
  const exported = await cli('approver', ['action-get', '--client', CA, '--request', requestId, '--preview-file', stored]);
  assert.equal(exported.code, 0);
  const approved = await cli('approver', ['action-approve', '--client', CA, '--request', requestId, '--hash', hash, '--preview-file', stored]);
  assert.deepEqual([approved.code, approved.output.state, approved.output.decision], [0, 'APPROVED', 'APPROVED']);
  const executed = await cli('executor', ['action-execute', '--client', CA, '--request', requestId, '--hash', hash]);
  assert.deepEqual([executed.code, executed.output.state, executed.output.attemptState, executed.output.verificationCount, executed.output.verificationCode,
    executed.output.synthetic], [0, 'VERIFIED', 'VERIFIED', 1, null, true]);
  const replay = await cli('executor', ['action-verify', '--client', CA, '--request', requestId]);
  assert.deepEqual([replay.code, replay.output.idempotent, replay.output.state], [0, true, 'VERIFIED']);
  const listed = await cli('reader', ['action-list', '--client', CA, '--limit', '100']);
  assert.ok((listed.output.items as { requestId: string; state: string }[]).some(i => i.requestId === requestId && i.state === 'VERIFIED'));
  const got = await cli('reader', ['action-get', '--client', CA, '--request', requestId]);
  assert.equal(got.output.state, 'VERIFIED');
  const cancel = await cli('requester', ['action-cancel', '--client', CA, '--request', requestId]);
  assert.deepEqual([cancel.code, cancel.output.safeErrorCode], [2, 'ACTION_ALREADY_RESERVED']);
  const none = await cli('executor', ['action-recover', '--client', CA, '--request', requestId]);
  assert.deepEqual([none.code, none.output.recovered], [0, 'NONE']);
  const [ticket] = await see.tickets(requestId);
  for (const run of [preview, request, exported, approved, executed, replay, listed, got, cancel, none, notDue]) assertPrivate(run, String(run.output.command), [ticket!, crashedTicket]);

  // The crashed reservation: OUTCOME_UNKNOWN only after its grace, then the candidate only through a protected file
  const attempt = (await see.attempt(crashed.requestId))!;
  await untilPassed(pgdb.owner, new Date(attempt.reservedAt.getTime() + RECOVERY_GRACE_MS));
  const recovered = await cli('executor', ['action-recover', '--client', CA, '--request', crashed.requestId]);
  assert.deepEqual([recovered.code, recovered.output.recovered, recovered.output.state], [0, 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN']);
  const wrong = await cli('executor', ['action-verify', '--client', CA, '--request', crashed.requestId, '--reconciliation-file',
    await candidateFile(files, crashed.requestId, randomUUID())]);
  assert.deepEqual([wrong.code, wrong.output.verificationResult, wrong.output.state, wrong.output.ordinal], [1, 'MISMATCH', 'OUTCOME_UNKNOWN', 1]);
  const exposed = files.out('cli-candidate-0644.json');
  await writePrivate(exposed, JSON.stringify({ kind: 'ACTION_RECONCILIATION_CANDIDATE', dto: 'action-candidate/1', requestId: crashed.requestId,
    candidateTicketId: crashedTicket }), 0o644);
  const insecure = await cli('executor', ['action-verify', '--client', CA, '--request', crashed.requestId, '--reconciliation-file', exposed]);
  assert.deepEqual([insecure.code, insecure.output.safeErrorCode], [2, 'ACTION_INPUT_INVALID']);
  const matched = await cli('executor', ['action-verify', '--client', CA, '--request', crashed.requestId, '--reconciliation-file',
    await candidateFile(files, crashed.requestId, crashedTicket)]);
  assert.deepEqual([matched.code, matched.output.state, matched.output.targetKind, matched.output.ordinal], [0, 'VERIFIED', 'CANDIDATE', 2]);
  for (const run of [recovered, wrong, insecure, matched]) assertPrivate(run, String(run.output.command), [crashedTicket]);
  assert.equal(existsSync(trapFile) ? readFileSync(trapFile, 'utf8') : '', '', 'no native network attempt in any action CLI process');
});
