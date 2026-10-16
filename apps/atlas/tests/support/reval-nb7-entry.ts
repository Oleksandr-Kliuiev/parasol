import { verifyTestRevision } from './reval-history.ts';
// TEST-ONLY NB7 rehearsal driver (rs-c/IMPLEMENTATION_BRIEF_C.md §4; 04 "consecutive target-platform ARM/READY rehearsal"), run under
// a live PTY so C/S accept it as I (same euid, node exe, a TTY). It drives the REAL instrument code — the measured IPC clients,
// MeasuredRun (PRE census → PRE → consume → ARM → READY → GO), the 06 transfer, finish (POST census) and receipt v4 — on the
// unchanged RC5 ExecutionSession, and plays the browser over loopback HTTP for each GO (reval-instrument-driver.ts). RS-D-A: the run
// follows the fixture-grouped order (owner decision D1), whose first segment is FX07 — the installed fixture. This process installs no
// network guard because it is also the browser. Prints `NB7_SUMMARY <json>` (counts and latencies only; no question, token or value).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameIdentity } from '../../scripts/ask-remote-eval-execution/artifact.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { ExecutionSession } from '../../scripts/ask-remote-eval-execution/session.ts';
import { ControlClient, HandoffClient } from '../../scripts/reval-instrument/ipc.ts';
import { withGroupedOrder } from '../../scripts/reval-instrument/order.ts';
import { buildReceiptV6, writeReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { MeasuredRun } from '../../scripts/reval-instrument/run.ts';
import { caseDriver, lineReader } from './reval-instrument-driver.ts';

interface Input { configDir: string; registrationId: string; databaseInstanceId: string; port: number; bearer: string; clientId: string; fixtureId: string; cycles: number;
  admission: { admissionId: string; startUtc: string; expiryUtc: string; dayCapMicro: string; monthCapMicro: string; openingFenceEpoch: string; pacingMax: string };
  policyVersion: string; receiptDir: string }
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Input;
const nextLine = lineReader();
const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const start = verifyTestRevision();
if (!start.snapshot.ok || !start.revision) { out(`NB7_FAILED IDENTITY ${start.snapshot.drift.join(',')}`); process.exit(1); }
const ctx = bindCorpus(start.snapshot);
const { corpus, order } = withGroupedOrder(ctx.corpus);
if (corpus.cases.get(corpus.order[0]!)!.fixtureId !== input.fixtureId) { out('NB7_FAILED ORDER'); process.exit(1); }
const control = await ControlClient.connect(join(input.configDir, 'reval-instrument.sock'), input.registrationId, input.databaseInstanceId);
const handoff = await HandoffClient.connect(join(input.configDir, 'reval-handoff.sock'), control);
out(`CONNECTED ${control.binding.connectionId} ${handoff.connectionId}`);
const [, nonce, ack] = (await nextLine()).split(' ');
const pairId = (JSON.parse(ack!) as { pairId: string }).pairId;
mkdirSync(input.receiptDir, { recursive: true, mode: 0o700 });
const session = new ExecutionSession({ runClass: 'UNADMITTED_LOCAL_OBSERVATION', clock: () => ({ utcMs: Date.now(), monoMs: performance.now() }),
  verify: () => verifyTestRevision().snapshot, nonce: () => randomUUID().slice(0, 8), corpus }, input.admission);
const connection = { registrationId: control.binding.registrationId, serverBootId: control.binding.serverBootId, controlConnectionId: control.binding.connectionId,
  handoffConnectionId: handoff.connectionId };
const run: MeasuredRun = new MeasuredRun({ session, corpus, order, ports: { control, handoff }, mono: () => performance.now(), wallMs: () => Date.now(),
  persist: () => { try { writeReceiptV6(input.receiptDir, buildReceiptV6(session, run, ctx.cases, start.revision!, connection), ctx.cases, 'REVAL_NB7.json'); return true; } catch { return false; } },
  identityHolds: () => sameIdentity(start.snapshot, verifyTestRevision().snapshot) });
const browser = { pairId: pairId!, sessionToken: '', policyVersion: input.policyVersion };
const drive = caseDriver({ port: input.port, bearer: input.bearer, clientId: input.clientId, admissionId: input.admission.admissionId, session, corpus, run, browser: () => browser });
browser.sessionToken = await drive.pair(nonce!);
if (run.confirm(input.admission.admissionId, input.policyVersion) !== 'CONFIRMED') { out('NB7_FAILED CONFIRM'); process.exit(1); }
if (run.setPair(ack) !== 'PAIR_RECORDED') { out('NB7_FAILED PAIR_ACK'); process.exit(1); }

const stats = { attempted: 0, succeeded: 0, failedBeforeConsumption: 0, failedAfterConsumption: 0, consumed: 0, preToArmMs: [] as number[], armMs: [] as number[], readyMs: [] as number[],
  goToCommitMs: [] as number[], outcomes: [] as string[] };
try {
  for (let i = 0; i < input.cycles; i += 1) {
    const caseId = session.nextCaseId!;
    await drive.prepare(caseId);
    if (i === 1) {
      // Injected failure BEFORE consumption: a stale confirmed tuple refuses at PRE; the case stays next and unconsumed.
      const tuple = run.tuple!; run.tuple = { ...tuple, policyVersion: String(BigInt(tuple.policyVersion) + 1n) };
      stats.attempted += 1;
      const r = await run.go(caseId);
      run.tuple = tuple;
      if (r !== 'BLOCKED_PRE_TUPLE' || session.nextCaseId !== caseId) throw new Error(`INJECT_BEFORE ${r}`);
      stats.failedBeforeConsumption += 1; // the session's staged/consented case and its capability preflight are untouched
    }
    stats.attempted += 1;
    const t0 = performance.now();
    const go = await run.go(caseId);
    if (!go.startsWith('GO_CLICK_ASK_NOW')) throw new Error(`GO ${go}`);
    stats.consumed += 1;
    await drive.browserCase(caseId);
    const h = await run.handoff();
    const f = await run.finish();
    if (h !== 'HANDOFF_COMMITTED' || !f.startsWith(`CASE_RECORDED ${caseId} ACTIVE COMMITTED`)) throw new Error(`FINISH ${h} ${f}`);
    stats.goToCommitMs.push(Math.round(performance.now() - t0));
    const m = run.cases.get(caseId)!; stats.preToArmMs.push(m.preToArmMs!); stats.armMs.push(m.armMs!); stats.readyMs.push(m.readyMs!); stats.outcomes.push(f.split(' ')[3]!);
    if (m.census !== 'MATCH') throw new Error(`CENSUS ${m.census} ${m.censusReason}`);
    stats.succeeded += 1;
    await sleep(13_000); // RC5 pacing: capability + submission ≤ 10 per 60 s, and the server's 10 questions per 60 s per actor
  }
  // Injected failure AFTER consumption: an ARM refused by C (foreign pair) consumes the case and stops arming for good.
  const caseId = session.nextCaseId!;
  await drive.prepare(caseId);
  run.setPair({ pairId: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString(), paired: false });
  stats.attempted += 1;
  const r = await run.go(caseId);
  if (!r.startsWith('ARM_FAILED_') || run.armStop !== 'ARM_PHASE_FAILURE' || session.state !== 'TERMINAL_INCOMPLETE') throw new Error(`INJECT_AFTER ${r}`);
  stats.consumed += 1; stats.failedAfterConsumption += 1;
  out(`NB7_SUMMARY ${JSON.stringify(stats)}`);
} catch (e) {
  out(`NB7_FAILED ${(e as Error).message.slice(0, 80)} ${JSON.stringify(stats)}`);
} finally { control.close(); handoff.close(); process.exit(0); }
