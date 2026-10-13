// Interactive operator session (UNADMITTED LOCAL OBSERVATION). Requires an interactive TTY on input AND output: a pipe
// cannot drive it, and consent needs a fresh per-case challenge shown only at that moment. A TTY is a guard against casual
// automation, NOT proof of who is typing: operator identity stays ATTESTED_UNVERIFIED. The terminal is put in RAW mode (kernel
// ECHO/ICANON/ISIG off) ONCE, before the first banner and artifact/corpus verification (the CLI arms it even before its dynamic
// imports), and stays raw for the WHOLE session — prompts, command processing and fsync intervals included; the prior mode is
// restored only at exit/cleanup, and a terminal that cannot be made raw fails closed before anything is displayed. Type-ahead
// is therefore never echoed by the kernel; it is buffered and consumed by the next prompt. Ctrl-C is a byte (no kernel SIGINT),
// read as ABORT at the next prompt and finalized. EVERY input — commands, metadata and pastes — goes through the buffer-safe
// collector (tty-input.ts) and is never written back; output is fixed codes, validated
// case/fixture IDs and counts only. The tool never sends anything: the operator clicks Ask in the accepted browser console
// ONLY after this tool printed GO_CLICK_ASK_NOW, which happens only after the in-flight receipt was persisted.
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import type { Clock } from '../ask-remote-eval/supervisor.ts';
import { admissionBlockers } from './artifact.ts';
import { loadContext } from './corpus.ts';
import { buildReceipt, lockRun, writeReceipt } from './receipt.ts';
import { ExecutionSession } from './session.ts';
import type { OutcomeInput } from './session.ts';
import { InputCollector } from './tty-input.ts';
import type { Collected } from './tty-input.ts';
import { codeOf } from './validate.ts';
import { verifyArtifact } from './artifact.ts';

export interface TtyIn { isTTY?: boolean; isRaw?: boolean; setRawMode(on: boolean): unknown; on(e: 'data', f: (b: Buffer) => void): unknown; off(e: 'data', f: (b: Buffer) => void): unknown; resume(): unknown; pause(): unknown }
export interface TtyOut { isTTY?: boolean; write(s: string): unknown }
export interface OperatorIo { readonly input: TtyIn; readonly output: TtyOut; readonly clock?: () => Clock; readonly nonce?: () => string; readonly signals?: boolean;
  /** Set by the CLI when it already armed raw mode before its imports: the mode to restore at exit. */
  readonly armedPrior?: boolean }

const BANNER = [
  'R-EVAL EXECUTION INSTRUMENT — UNADMITTED LOCAL OBSERVATION. Live admission: BLOCKED. No paid call path exists in this tool.',
  'It sends nothing. Click Ask in the browser ONLY after this tool prints GO_CLICK_ASK_NOW; any other output means DO NOT CLICK.',
  'If you clicked without GO (or twice), report it at once: unrecorded-click <caseId> (consumed, integrity failure).',
  'ALL input is read with echo OFF (lines end with Enter, pastes with Ctrl-D). Pastes are NOT hidden from the clipboard,',
  'browser devtools or screen recording. Never put questions or bodies in shell commands/history, files or logs.',
  'Typed admission/counters/ledger/closure values are ATTESTED. Time gates use this computer\'s clock: LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED.',
  'Pacing counts only events reported here; browser fetches you do not report are not counted. Type "help".'
];
const HELP = [
  'admission              owner admission values (once; exclusive run lock in the receipt dir)',
  'confirm                admissionId + policyVersion of the disclosed tuple',
  'counters               current DAY/MONTH accounted micro-USD before THIS submission',
  'capability             paste the capability reply (status, correlation header, body) = preflight; a re-pasted reply is refused',
  'next | status          next case ID / fixture / requested focus; run state',
  'stage                  requested focus (syn-obs-… or none) + paste the question — strict equality',
  'consent                tick the browser checkbox, then type the shown challenge',
  'submit                 gate for the next case: only GO_CLICK_ASK_NOW allows the click; otherwise DO NOT CLICK',
  'arrived                press Enter when the reply/error becomes visible (latency end)',
  'outcome                paste request body, reply, then ledger metadata',
  'unrecorded-click       report a click on Ask without GO or a second click (consumed, integrity failure)',
  'deviation              report that the submitted text differed (consumed CASE_FAIL)',
  'closure | pause | resume-day | resume-pause | export | quit'
];
const COMMANDS = new Set(['help', 'admission', 'confirm', 'counters', 'capability', 'next', 'status', 'stage', 'consent', 'submit', 'arrived', 'outcome',
  'unrecorded-click', 'deviation', 'closure', 'pause', 'resume-day', 'resume-pause', 'export', 'quit']);

class Aborted extends Error { constructor() { super('ABORTED'); } }

export async function runOperatorSession(receiptDir: string, io: OperatorIo = { input: process.stdin, output: process.stdout, signals: true }): Promise<number> {
  if (!io.input.isTTY || !io.output.isTTY) { process.stderr.write('SESSION_REQUIRES_INTERACTIVE_TTY\n'); return 2; }
  const prior = io.armedPrior ?? io.input.isRaw === true;
  /** Restore exactly the mode found before arming (raw stays raw); called only at session exit/cleanup. */
  const restore = (): void => { try { if (!prior) io.input.setRawMode(false); } catch { /* terminal gone */ } io.input.pause(); };
  if (io.armedPrior === undefined) { try { io.input.setRawMode(true); } catch { /* checked below */ } }
  if (io.input.isRaw !== true) { restore(); process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); return 2; }
  try { return await interactive(receiptDir, io, restore); } finally { restore(); }
}

async function interactive(receiptDir: string, io: OperatorIo, restore: () => void): Promise<number> {
  const out = (line: string): void => { io.output.write(`${line}\n`); };
  try { if (!statSync(receiptDir).isDirectory()) throw new Error(); } catch { process.stderr.write('RECEIPT_DIR_INVALID\n'); return 2; }
  let pending: Buffer = Buffer.alloc(0);
  /** One input with the terminal still raw; listeners/pause are managed per prompt, the terminal mode never is. Malformed or
   * oversized input is a fixed-code rejection (re-prompt); Ctrl-C aborts; bytes after the terminator wait for the next prompt. */
  const read = (prompt: string, paste: boolean): Promise<string> => new Promise((resolve, rejectRead) => {
    io.output.write(paste ? `${prompt} (echo off; end with Ctrl-D): ` : `${prompt} (echo off): `);
    const collector = new InputCollector(paste);
    const settle = (r: Collected): void => {
      pending = collector.remainder; io.output.write('\n');
      if (r.kind === 'ABORT') rejectRead(new Aborted());
      else if (r.kind === 'REJECTED') rejectRead(Object.assign(new Error(r.code), { fixed: r.code }));
      else resolve(r.value);
    };
    const onData = (b: Buffer): void => {
      const r: Collected | null = collector.feed(b);
      if (r === null) return;
      io.input.off('data', onData); io.input.pause(); settle(r);
    };
    const queued = pending; pending = Buffer.alloc(0);
    const early = queued.length > 0 ? collector.feed(queued) : null;
    if (early !== null) { settle(early); return; }
    io.input.on('data', onData); io.input.resume();
  });
  const line = (p: string): Promise<string> => read(p, false);
  const paste = (p: string): Promise<string> => read(p, true);

  BANNER.forEach(out);
  const ctx = loadContext();
  out(`ARTIFACT ${ctx.snapshot.ok ? 'VERIFIED' : 'DRIFT'} files=${ctx.snapshot.filesChecked} drift=${ctx.snapshot.drift.join(',') || 'none'}`);
  out(`LIVE_ADMISSION BLOCKED: ${admissionBlockers(ctx.snapshot).join(',')}`);
  if (!ctx.snapshot.ok) return 1;
  let session: ExecutionSession | null = null; let receiptName = ''; let persisted = true;
  /** Persist the current safe state; on failure supervision stops (only export/quit remain) and the old receipt stays. */
  const save = (): boolean => {
    if (!session) return true;
    try { writeReceipt(receiptDir, buildReceipt(session, ctx.cases), ctx.cases, receiptName); persisted = true; }
    catch (e) { persisted = false; out(`${codeOf(e)} RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK`); }
    return persisted;
  };
  /** Quit/Ctrl-C/signal/fatal: an in-flight case is recorded ABANDONED_IN_FLIGHT (unknown commit) before the final save. */
  const finalize = (): void => { if (session && session.inFlight !== null) out(session.abandonInFlight()); save(); };
  const onSignal = (): void => { finalize(); out('SESSION_ENDED_BY_SIGNAL'); restore(); process.exit(130); };
  if (io.signals) {
    process.once('SIGTERM', onSignal); process.once('SIGHUP', onSignal); process.once('SIGINT', onSignal);
    process.once('uncaughtException', () => { try { finalize(); } catch { /* best effort: the last persisted receipt stays */ } out('SESSION_ENDED_FATAL'); restore(); process.exit(1); });
  }
  const need = (): ExecutionSession => session ?? (() => { throw Object.assign(new Error('NO_SESSION'), { fixed: 'NO_ADMISSION_YET' }); })();
  const http = async () => ({ status: await line('HTTP status'), correlationHeader: await line('x-atlas-correlation-id'), body: await paste('Body') });

  for (;;) {
    let cmd = '';
    try {
      cmd = (await line('reval>')).trim();
      if (!COMMANDS.has(cmd)) { if (cmd !== '') out('UNKNOWN_COMMAND'); continue; }
      out(`[${cmd}]`);
      if (!persisted && cmd !== 'export' && cmd !== 'quit') { out('BLOCKED_RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK'); continue; }
      if (cmd === 'help') { HELP.forEach(out); continue; }
      if (cmd === 'admission') {
        if (session) { out('ADMISSION_ALREADY_SET'); continue; }
        const input = { admissionId: await line('admissionId'), startUtc: await line('start UTC'), expiryUtc: await line('expiry UTC'),
          dayCapMicro: await line('DAY cap micro-USD'), monthCapMicro: await line('MONTH cap micro-USD'), openingFenceEpoch: await line('opening fence epoch'),
          pacingMax: await line('pacing max per 60 s (≤10)') };
        const created = new ExecutionSession({ runClass: 'UNADMITTED_LOCAL_OBSERVATION', clock: io.clock ?? (() => ({ utcMs: Date.now(), monoMs: performance.now() })),
          verify: verifyArtifact, nonce: io.nonce ?? (() => randomBytes(4).toString('hex')), corpus: ctx.corpus }, input);
        lockRun(receiptDir, created.admission.admissionId);
        session = created; receiptName = `REVAL_EXECUTION_${created.admission.admissionId}.json`;
        out('ADMISSION_RECORDED_ATTESTED');
      } else if (cmd === 'confirm') out(need().confirmTuple(await line('admissionId'), await line('policyVersion')));
      else if (cmd === 'counters') out(need().counters({ dayChargedMicro: await line('DAY charged micro-USD'), monthChargedMicro: await line('MONTH charged micro-USD') }));
      else if (cmd === 'capability') out(need().capability(await http()));
      else if (cmd === 'next' || cmd === 'status') {
        const s = need(); const n = s.nextSetup();
        out(`STATE ${s.state} CLOSURE ${s.closureState} VOLUNTARY ${s.voluntary} IN_FLIGHT ${s.inFlight ?? 'none'}`);
        out(n ? `NEXT ${n.caseId} FIXTURE ${n.fixtureId} FOCUS ${n.requestedFocus ?? 'none'}` : 'NEXT none');
        continue;
      } else if (cmd === 'stage') {
        const s = need(); const id = s.nextCaseId ?? '';
        out(s.stage(id, await line(`requested focus for ${id}`), await paste('Question exactly as pasted into the browser')));
      } else if (cmd === 'consent') {
        const s = need(); const id = s.nextCaseId ?? '';
        const nonce = s.consentChallenge(id);
        out(`Tick the browser consent checkbox for THIS question now. Then type the challenge for ${id}: ${nonce}`);
        const typed = (await line('challenge')).trim();
        const ticked = (await line('Checkbox ticked manually for this question? (type YES)')) === 'YES';
        out(s.consent(id, typed, ticked));
      } else if (cmd === 'submit') {
        const s = need(); const r = s.submit(s.nextCaseId ?? '');
        if (r !== 'DISPATCH') { out(`${r} DO_NOT_CLICK`); save(); continue; }
        if (save()) { out(`GO_CLICK_ASK_NOW ${s.inFlight}`); continue; }
        out(s.abandonInFlight()); out('DO_NOT_CLICK');
      } else if (cmd === 'arrived') out(need().arrived(need().inFlight));
      else if (cmd === 'unrecorded-click') out(need().unrecordedClick(await line('case ID that was clicked')));
      else if (cmd === 'outcome') {
        const s = need(); const id = s.inFlight;
        if (id === null) { out('BLOCKED_NOT_IN_FLIGHT'); continue; }
        const request = await paste('Request body (AskRequestV2 as sent)');
        const kind = await line('reply: response | timeout | unparseable');
        const ledger = (await line('ledger metadata available from owner read? (yes/no)')) === 'yes' ? {
          correlationId: await line('ledger correlationId'), attempts: await line('attempts'), settlement: await line('settlement enum'),
          chargedMicro: await line('charged micro-USD'), dayChargedMicro: await line('DAY charged after'), monthChargedMicro: await line('MONTH charged after') } : null;
        let input: OutcomeInput;
        if (kind === 'timeout') input = { request, reply: 'TIMEOUT', ledger };
        else {
          const reply = kind === 'unparseable' ? { status: await line('HTTP status'), correlationHeader: '', body: '' } : await http();
          const configFaultAttested = (await line('owner-confirmed configuration/circuit fault? (yes/no)')) === 'yes';
          input = { request, reply, replyUnparseable: kind === 'unparseable', ledger, configFaultAttested };
        }
        out(String(s.outcome(id, input)));
      } else if (cmd === 'deviation') out(need().deviation(await line('case ID')));
      else if (cmd === 'closure') {
        out(need().closure({ admissionId: await line('admissionId'), paused: await line('paused (true/false)'), policyVersion: await line('policyVersion'),
          fenceEpoch: await line('fenceEpoch') }));
      } else if (cmd === 'pause') out(need().voluntaryPause());
      else if (cmd === 'resume-day') out(need().resumeDay());
      else if (cmd === 'resume-pause') out(need().resumeVoluntary());
      else if (cmd === 'export') { if (session) out(save() ? 'RECEIPT_WRITTEN' : 'RECEIPT_NOT_PERSISTED'); continue; }
      else if (cmd === 'quit') {
        finalize();
        if (session && (session.closureState === 'PENDING' || session.voluntary === 'PENDING')) out('WARNING_CLOSURE_PENDING');
        return persisted ? 0 : 1;
      }
      save();
    } catch (e) {
      if (e instanceof Aborted) { finalize(); out('SESSION_ENDED_BY_CTRL_C'); return 130; }
      const fixed = (e as { fixed?: string }).fixed;
      out(fixed ?? codeOf(e, 'INPUT_REJECTED'));
      if (session && cmd !== 'export' && cmd !== 'quit') save();
    }
  }
}
