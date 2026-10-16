// TEST-ONLY segment rehearsal driver (rs-d brief A §6, brief C §1.8; owner decisions D1/D2), run under a live PTY as I (like the NB7
// driver): the REAL instrument code on the unchanged RC5 ExecutionSession follows the fixture-grouped order and crosses every fixture
// boundary with S and C up: GO is refused before the voluntary-pause closure and before the DRAIN (nothing consumed), the owner's
// closure is entered, DRAIN must be QUIESCENT, C's proofs are taken, the owner switches the fixture, re-checks, resumes and re-pairs,
// and the run continues. `maxSegments`/`lastSegmentCases` bound it (RS-D-A: 2 segments, 2 cases of the second; RS-D-C integrated
// rehearsal: all 11, all 200 cases). Proofs are taken before the first GO, after every segment and at the end. The browser is played
// over loopback HTTP. Lines from the test: `PAIR <nonce> <ackJson>`, `CLOSURE <json>`, `RESUMED <nonce> <policyVersion> <ackJson>`,
// `REPAIRED <nonce> <ackJson>` (ackJson = the owner's PAIR_ACK payload, compact).
// Prints fixed codes and a summary only.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameIdentity } from '../../scripts/ask-remote-eval-execution/artifact.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { ExecutionSession } from '../../scripts/ask-remote-eval-execution/session.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import { ControlClient, HandoffClient } from '../../scripts/reval-instrument/ipc.ts';
import { withGroupedOrder } from '../../scripts/reval-instrument/order.ts';
import { buildReceiptV6, writeReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { MeasuredRun } from '../../scripts/reval-instrument/run.ts';
import { caseDriver, lineReader } from './reval-instrument-driver.ts';

interface Input { configDir: string; registrationId: string; databaseInstanceId: string; port: number; bearer: string; clientId: string;
  maxSegments: number; lastSegmentCases: number | null; repairAfterCases?: number | null;
  admission: { admissionId: string; startUtc: string; expiryUtc: string; dayCapMicro: string; monthCapMicro: string; openingFenceEpoch: string; pacingMax: string };
  policyVersion: string; receiptDir: string; paceMs: number; receiptName: string }
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Input;
const nextLine = lineReader();
const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const expect = (got: string, want: string | RegExp, what: string) => {
  if (typeof want === 'string' ? got !== want : !want.test(got)) throw new Error(`${what} ${got}`);
};

const start = verifyRevision();
if (!start.snapshot.ok || !start.revision) { out(`SEGMENTS_FAILED IDENTITY ${start.snapshot.drift.join(',')}`); process.exit(1); }
const ctx = bindCorpus(start.snapshot);
const { corpus, order } = withGroupedOrder(ctx.corpus);
const fx = (id: string) => corpus.cases.get(id)!.fixtureId;
/** As an operator retyping `connect` while S is still starting: bounded retries of a refused connection (nothing else is retried). */
async function connectBoth(): Promise<{ control: ControlClient; handoff: HandoffClient }> {
  for (let i = 0; ; i += 1) {
    let c: ControlClient | null = null;
    try {
      c = await ControlClient.connect(join(input.configDir, 'reval-instrument.sock'), input.registrationId, input.databaseInstanceId);
      return { control: c, handoff: await HandoffClient.connect(join(input.configDir, 'reval-handoff.sock'), c) };
    } catch (e) {
      c?.close();
      if ((e as { code?: string }).code !== 'IPC_CONNECT_FAILED' || i >= 20) throw e;
      await sleep(500);
    }
  }
}
const { control, handoff } = await connectBoth();
out(`CONNECTED ${control.binding.connectionId} ${handoff.connectionId}`);
mkdirSync(input.receiptDir, { recursive: true, mode: 0o700 });
const session = new ExecutionSession({ runClass: 'UNADMITTED_LOCAL_OBSERVATION', clock: () => ({ utcMs: Date.now(), monoMs: performance.now() }),
  verify: () => verifyRevision().snapshot, nonce: () => randomUUID().slice(0, 8), corpus }, input.admission);
const connection = { registrationId: control.binding.registrationId, serverBootId: control.binding.serverBootId, controlConnectionId: control.binding.connectionId,
  handoffConnectionId: handoff.connectionId };
const run: MeasuredRun = new MeasuredRun({ session, corpus, order, ports: { control, handoff }, mono: () => performance.now(), wallMs: () => Date.now(),
  persist: () => { try { writeReceiptV6(input.receiptDir, buildReceiptV6(session, run, ctx.cases, start.revision!, connection), ctx.cases, input.receiptName); return true; } catch { return false; } },
  identityHolds: () => sameIdentity(start.snapshot, verifyRevision().snapshot) });
const browser = { pairId: '', sessionToken: '', policyVersion: input.policyVersion };
const drive = caseDriver({ port: input.port, bearer: input.bearer, clientId: input.clientId, admissionId: input.admission.admissionId, session, corpus, run, browser: () => browser });
/** The browser PAIR with the owner's nonce, then the operator's `pair-ack` (the owner's PAIR_ACK: pairId + nonce expiry). */
async function pairFrom(nonce: string, ack: string): Promise<void> {
  browser.pairId = (JSON.parse(ack) as { pairId: string }).pairId; browser.sessionToken = await drive.pair(nonce); pairedAt = Date.now();
  expect(run.setPair(ack), 'PAIR_RECORDED', 'PAIR_ACK');
}
const paired = async (nonce: string, ack: string, policyVersion: string) => {
  await pairFrom(nonce, ack); browser.policyVersion = policyVersion;
  expect(run.confirm(input.admission.admissionId, policyVersion), 'CONFIRMED', 'CONFIRM');
};

const summary = { segments: [] as { fixtureId: string; cases: string[] }[], refusals: [] as string[], drains: [] as string[], proofs: [] as string[], finalDrain: '',
  repairs: 0 };
let pairedAt = Date.now();
/** RS-D-C: a re-pair inside a segment (S ends a browser pair 10 min after its PAIR; the instrument refuses a GO once less than its
 *  case reserve remains, from the PAIR_ACK expiry): the owner ends the pair and installs a new one, the browser pairs, the operator
 *  enters the new PAIR_ACK. Line: `REPAIRED <nonce> <ackJson>`. */
async function repair(): Promise<void> {
  out('NEED_REPAIR');
  const [, nonce, ack] = (await nextLine()).split(' ');
  await pairFrom(nonce!, ack!); summary.repairs += 1;
}
/** RS-D-B: a transient UNKNOWN (e.g. the owner's just-finished executor session still visible) is retried, as an operator would. */
async function drained(): Promise<string> {
  for (let i = 0; ; i += 1) {
    const r = await run.drain();
    if (!r.startsWith('DRAIN UNKNOWN') || i >= 10) return r;
    await sleep(300);
  }
}
async function proofs(): Promise<void> { const r = await run.takeProofs(); expect(r, /^PROOFS /, 'PROOFS'); summary.proofs.push(r); }
/** One fixture boundary (D1/D2): both refusals consume nothing; closure; DRAIN QUIESCENT; proofs; the owner's switch; resume; re-PAIR. */
async function boundary(next: string): Promise<void> {
  let r = await run.go(next); expect(r, 'BLOCKED_SEGMENT_CLOSURE_REQUIRED', 'NO_CLOSURE'); summary.refusals.push(r);
  expect(session.voluntaryPause(), 'PAUSED_CLOSURE_PENDING', 'PAUSE');
  out(`NEED_CLOSURE ${run.tuple?.policyVersion ?? ''}`);
  const closure = JSON.parse((await nextLine()).slice('CLOSURE '.length)) as Record<string, unknown>;
  expect(session.closure({ admissionId: closure.admissionId, paused: String(closure.paused), policyVersion: closure.policyVersion, fenceEpoch: closure.fenceEpoch }),
    'CONFIRMED', 'CLOSURE');
  r = await run.go(next); expect(r, 'BLOCKED_SEGMENT_DRAIN_REQUIRED', 'NO_DRAIN'); summary.refusals.push(r);
  const d = await drained(); expect(d, /^DRAIN QUIESCENT INTACT /, 'DRAIN'); summary.drains.push(d);
  await proofs();
  out('DRAINED');
  const [, nonce, policyVersion, ack] = (await nextLine()).split(' ');
  expect(session.resumeVoluntary(), 'RESUMED_CONFIRM_NEWER_TUPLE', 'RESUME');
  await paired(nonce!, ack!, policyVersion!);
}
try {
  const [, nonce, ack] = (await nextLine()).split(' '); await paired(nonce!, ack!, input.policyVersion);
  await proofs(); // before the first GO
  for (;;) {
    const id = session.nextCaseId;
    if (id === null) break;
    const current = summary.segments.at(-1);
    if (current && current.fixtureId !== fx(id)) {
      if (summary.segments.length >= input.maxSegments) break;
      await boundary(id);
    }
    const seg = summary.segments.at(-1)?.fixtureId === fx(id) ? summary.segments.at(-1)! : (summary.segments.push({ fixtureId: fx(id), cases: [] }), summary.segments.at(-1)!);
    if (summary.segments.length === input.maxSegments && input.lastSegmentCases !== null && seg.cases.length >= input.lastSegmentCases) break;
    if (seg.cases.length > 0 || summary.segments.length > 1) await sleep(input.paceMs); // RC5 pacing and the server's per-actor limit
    const played = summary.segments.reduce((n, x) => n + x.cases.length, 0);
    if ((input.repairAfterCases && played === input.repairAfterCases && summary.repairs === 0) || Date.now() - pairedAt > 5.5 * 60_000) await repair();
    await drive.play(id); seg.cases.push(id);
    if (summary.segments.reduce((n, x) => n + x.cases.length, 0) % 20 === 0) out(`PROGRESS ${summary.segments.reduce((n, x) => n + x.cases.length, 0)}`);
  }
  summary.finalDrain = await drained(); expect(summary.finalDrain, /^DRAIN QUIESCENT INTACT /, 'FINAL_DRAIN');
  await proofs();
  out(`SEGMENTS_SUMMARY ${JSON.stringify(summary)}`);
} catch (e) {
  out(`SEGMENTS_FAILED ${(e as Error).message.slice(0, 120)} ${JSON.stringify({ ...summary, segments: summary.segments.map(x => [x.fixtureId, x.cases.length]) })}`);
} finally { control.close(); handoff.close(); process.exit(0); }
