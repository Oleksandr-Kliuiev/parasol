// Interactive session of the instrument revision (rs-c brief B; UNADMITTED, no paid path). Same TTY discipline as the accepted
// RC5 operator: RAW mode for the whole session (armed by the CLI before its imports), every input through the buffer-safe
// collector, fixed-code output only, a receipt persisted after every command. Differences: the instrument connects to the
// owner's measured sockets (`connect` prints the two connection IDs for the owner's `pair`), counters/arrival/request/reply/
// ledger are MEASURED (GO step and `finish`), and `go` performs the 04 GO procedure before printing GO_CLICK_ASK_NOW. RS-D-A: the run
// follows the fixture-grouped order (owner decision D1, order.ts); GO and `finish` take process censuses; `drain` records C's DRAIN
// (required, QUIESCENT, inside the voluntary-pause closure at each fixture-segment boundary); `census` is a diagnostic read.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadOwnerConfig } from '../../packages/reval/config.ts';
import { bindCorpus } from '../ask-remote-eval-execution/corpus.ts';
import { lockRun } from '../ask-remote-eval-execution/receipt.ts';
import { ExecutionSession } from '../ask-remote-eval-execution/session.ts';
import { InputCollector } from '../ask-remote-eval-execution/tty-input.ts';
import type { Collected } from '../ask-remote-eval-execution/tty-input.ts';
import { codeOf } from '../ask-remote-eval-execution/validate.ts';
import { sameIdentity } from '../ask-remote-eval-execution/artifact.ts';
import type { OperatorIo } from '../ask-remote-eval-execution/operator.ts';
import { verifyRevision } from './identity.ts';
import { ControlClient, HandoffClient } from './ipc.ts';
import { allowUnixSockets, guardInstalled } from './net-guard.ts';
import { decodeSnapshot } from './ledger.ts';
import { withGroupedOrder } from './order.ts';
import { buildReceiptV6, writeReceiptV6 } from './receipt.ts';
import { MeasuredRun } from './run.ts';

const BANNER = [
  'R-EVAL INSTRUMENT REVISION (RS-D-C) — UNADMITTED. Live admission: BLOCKED. No paid call path exists in this tool.',
  'Click Ask in the browser ONLY after this tool prints GO_CLICK_ASK_NOW; any other output means DO NOT CLICK.',
  'Counters, arrival, request/reply and ledger are MEASURED (controller snapshots, server-bound handoff); admission, capability',
  'and consent stay ATTESTED. ALL input is read with echo OFF (lines end with Enter, pastes with Ctrl-D). Type "help".'];
const HELP = ['connect | admission | confirm | capability | pair-ack | next | status | stage | consent | go | handoff | abandon-handoff | finish',
  'unrecorded-click | deviation | closure | pause | drain | census | proofs | resume-day | resume-pause | export | quit'];
const COMMANDS = new Set(['help', 'connect', 'admission', 'confirm', 'capability', 'pair-ack', 'next', 'status', 'stage', 'consent', 'go', 'handoff', 'abandon-handoff', 'finish',
  'unrecorded-click', 'deviation', 'closure', 'pause', 'drain', 'census', 'proofs', 'resume-day', 'resume-pause', 'export', 'quit']);
class Aborted extends Error { constructor() { super('ABORTED'); } }

export async function runInstrumentSession(ownerConfig: string, receiptDir: string, io: OperatorIo): Promise<number> {
  if (!io.input.isTTY || !io.output.isTTY) { process.stderr.write('SESSION_REQUIRES_INTERACTIVE_TTY\n'); return 2; }
  const prior = io.armedPrior ?? io.input.isRaw === true;
  const restore = (): void => { try { if (!prior) io.input.setRawMode(false); } catch { /* terminal gone */ } io.input.pause(); };
  if (io.armedPrior === undefined) { try { io.input.setRawMode(true); } catch { /* checked below */ } }
  if (io.input.isRaw !== true) { restore(); process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); return 2; }
  try { return await interactive(ownerConfig, receiptDir, io, restore); } finally { restore(); }
}

async function interactive(ownerConfig: string, receiptDir: string, io: OperatorIo, restore: () => void): Promise<number> {
  const out = (line: string): void => { io.output.write(`${line}\n`); };
  try { if (!statSync(receiptDir).isDirectory()) throw new Error(); } catch { process.stderr.write('RECEIPT_DIR_INVALID\n'); return 2; }
  let config;
  try { config = await loadOwnerConfig(ownerConfig); } catch { process.stderr.write('OWNER_CONFIG_INVALID\n'); return 2; }
  let pending: Buffer = Buffer.alloc(0);
  const read = (prompt: string, paste: boolean): Promise<string> => new Promise((resolve, rejectRead) => {
    io.output.write(paste ? `${prompt} (echo off; end with Ctrl-D): ` : `${prompt} (echo off): `);
    const collector = new InputCollector(paste);
    const settle = (r: Collected): void => {
      pending = collector.remainder; io.output.write('\n');
      if (r.kind === 'ABORT') rejectRead(new Aborted());
      else if (r.kind === 'REJECTED') rejectRead(Object.assign(new Error(r.code), { fixed: r.code }));
      else resolve(r.value);
    };
    const onData = (b: Buffer): void => { const r = collector.feed(b); if (r === null) return; io.input.off('data', onData); io.input.pause(); settle(r); };
    const queued = pending; pending = Buffer.alloc(0);
    const early = queued.length > 0 ? collector.feed(queued) : null;
    if (early !== null) { settle(early); return; }
    io.input.on('data', onData); io.input.resume();
  });
  const line = (p: string): Promise<string> => read(p, false);
  const paste = (p: string): Promise<string> => read(p, true);

  BANNER.forEach(out);
  const start = verifyRevision();
  out(`ARTIFACT ${start.snapshot.ok ? 'VERIFIED' : 'DRIFT'} files=${start.snapshot.filesChecked} drift=${start.snapshot.drift.join(',') || 'none'}`);
  if (!start.snapshot.ok || start.revision === null) return 1;
  const ctx = bindCorpus(start.snapshot);
  let grouped;
  try { grouped = withGroupedOrder(ctx.corpus); } catch { out('ORDER_DRIFT'); return 1; }
  const { corpus, order } = grouped;
  out(`ORDER ${order.rule} ${order.sha256}`);
  const verify = () => verifyRevision().snapshot;
  const dir = dirname(ownerConfig);
  // The only network the process may open: the owner's two measured sockets (the CLI installed the guard first).
  if (guardInstalled()) allowUnixSockets([join(dir, 'reval-instrument.sock'), join(dir, 'reval-handoff.sock')]);
  let control: ControlClient | null = null; let handoff: HandoffClient | null = null;
  let session: ExecutionSession | null = null; let run: MeasuredRun | null = null; let receiptName = ''; let persisted = true;
  const save = (): boolean => {
    if (!session || !run || !control || !handoff) return true;
    try {
      writeReceiptV6(receiptDir, buildReceiptV6(session, run, ctx.cases, start.revision!, { registrationId: control.binding.registrationId,
        serverBootId: control.binding.serverBootId, controlConnectionId: control.binding.connectionId, handoffConnectionId: handoff.connectionId }), ctx.cases, receiptName);
      persisted = true;
    } catch (e) { persisted = false; out(`${codeOf(e)} RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK`); }
    return persisted;
  };
  const finalize = (): void => { if (session && session.inFlight !== null) out(session.abandonInFlight()); save(); control?.close(); handoff?.close(); };
  const onSignal = (): void => { finalize(); out('SESSION_ENDED_BY_SIGNAL'); restore(); process.exit(130); };
  if (io.signals) {
    process.once('SIGTERM', onSignal); process.once('SIGHUP', onSignal); process.once('SIGINT', onSignal);
    process.once('uncaughtException', () => { try { finalize(); } catch { /* the last persisted receipt stays */ } out('SESSION_ENDED_FATAL'); restore(); process.exit(1); });
  }
  const need = (): { s: ExecutionSession; r: MeasuredRun } => session && run ? { s: session, r: run } : (() => { throw Object.assign(new Error('NO_SESSION'), { fixed: 'NO_ADMISSION_YET' }); })();
  const http = async () => ({ status: await line('HTTP status'), correlationHeader: await line('x-atlas-correlation-id'), body: await paste('Body') });

  for (;;) {
    let cmd = '';
    try {
      cmd = (await line('instrument>')).trim();
      if (!COMMANDS.has(cmd)) { if (cmd !== '') out('UNKNOWN_COMMAND'); continue; }
      out(`[${cmd}]`);
      if (!persisted && cmd !== 'export' && cmd !== 'quit') { out('BLOCKED_RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK'); continue; }
      if (cmd === 'help') { HELP.forEach(out); continue; }
      if (cmd === 'connect') {
        if (control) { out('ALREADY_CONNECTED'); continue; }
        const c = await ControlClient.connect(join(dir, 'reval-instrument.sock'), config.registrationId, config.databaseInstanceId);
        try { handoff = await HandoffClient.connect(join(dir, 'reval-handoff.sock'), c); } catch (e) { c.close(); throw e; }
        control = c;
        out(`CONNECTED ${c.binding.connectionId} ${handoff.connectionId}`);
        continue;
      }
      if (cmd === 'admission') {
        if (session) { out('ADMISSION_ALREADY_SET'); continue; }
        if (!control || !handoff) { out('BLOCKED_NOT_CONNECTED'); continue; }
        const input = { admissionId: await line('admissionId'), startUtc: await line('start UTC'), expiryUtc: await line('expiry UTC'),
          dayCapMicro: await line('DAY cap micro-USD'), monthCapMicro: await line('MONTH cap micro-USD'), openingFenceEpoch: await line('opening fence epoch'),
          pacingMax: await line('pacing max per 60 s (≤10)') };
        const a = await control.request('SNAPSHOT', {});
        if (a.kind !== 'SNAPSHOT') { out(`BLOCKED_SNAPSHOT_${(a.payload as { code: string }).code}`); continue; }
        const snap = decodeSnapshot(a.payload);
        // Attested owner values must agree with the controller-measured policy (admission, caps, expiry ceiling, fence floor).
        if (snap.admissionId !== input.admissionId.trim() || snap.dayCapMicroUsd !== input.dayCapMicro.trim() || snap.monthCapMicroUsd !== input.monthCapMicro.trim()
          || !(Date.parse(input.expiryUtc.trim()) <= Date.parse(snap.expiresAt)) || !/^[0-9]{1,19}$/.test(input.openingFenceEpoch.trim())
          || BigInt(input.openingFenceEpoch.trim()) > BigInt(snap.fenceEpoch)) { out('BLOCKED_ADMISSION_SNAPSHOT_MISMATCH'); continue; }
        const created = new ExecutionSession({ runClass: 'UNADMITTED_LOCAL_OBSERVATION', clock: io.clock ?? (() => ({ utcMs: Date.now(), monoMs: performance.now() })),
          verify, nonce: io.nonce ?? (() => randomBytes(4).toString('hex')), corpus }, input);
        lockRun(receiptDir, created.admission.admissionId);
        session = created; receiptName = `REVAL_INSTRUMENT_${created.admission.admissionId}.json`;
        const c = control; const h = handoff;
        run = new MeasuredRun({ session: created, corpus, order, ports: { control: c, handoff: h }, mono: () => performance.now(), wallMs: () => Date.now(),
          persist: save, identityHolds: () => sameIdentity(start.snapshot, verify()) });
        out('ADMISSION_RECORDED_ATTESTED_SNAPSHOT_CROSSCHECKED');
      } else if (cmd === 'confirm') out(need().r.confirm(await line('admissionId'), await line('policyVersion')));
      else if (cmd === 'capability') out(need().s.capability(await http()));
      else if (cmd === 'pair-ack') out(need().r.setPair((await line('the owner OK PAIR_ACK line')).trim())); // RS-D-C: pairId + nonce expiry
      else if (cmd === 'next' || cmd === 'status') {
        const { s, r } = need(); const n = s.nextSetup();
        out(`STATE ${s.state} CLOSURE ${s.closureState} VOLUNTARY ${s.voluntary} IN_FLIGHT ${s.inFlight ?? 'none'} ARM_STOP ${r.armStop ?? 'none'}`);
        out(n ? `NEXT ${n.caseId} FIXTURE ${n.fixtureId} FOCUS ${n.requestedFocus ?? 'none'}` : 'NEXT none');
        continue;
      } else if (cmd === 'stage') {
        const { s } = need(); const id = s.nextCaseId ?? '';
        out(s.stage(id, await line(`requested focus for ${id}`), await paste('Question exactly as typed into the browser')));
      } else if (cmd === 'consent') {
        const { s } = need(); const id = s.nextCaseId ?? '';
        const nonce = s.consentChallenge(id);
        out(`Tick the browser consent checkbox for THIS question now. Then type the challenge for ${id}: ${nonce}`);
        const typed = (await line('challenge')).trim();
        const ticked = (await line('Checkbox ticked manually for this question? (type YES)')) === 'YES';
        out(s.consent(id, typed, ticked));
      } else if (cmd === 'go') {
        const { s, r } = need(); const id = s.nextCaseId ?? '';
        const res = await r.go(id);
        out(res.startsWith('GO_CLICK_ASK_NOW') ? res : `${res} DO_NOT_CLICK`);
      } else if (cmd === 'handoff') out(await need().r.handoff());
      else if (cmd === 'abandon-handoff') out(need().r.abandonHandoff());
      else if (cmd === 'finish') out(await need().r.finish());
      else if (cmd === 'unrecorded-click') out(need().s.unrecordedClick(await line('case ID that was clicked')));
      else if (cmd === 'deviation') out(need().s.deviation(await line('case ID')));
      else if (cmd === 'closure') {
        out(need().s.closure({ admissionId: await line('admissionId'), paused: await line('paused (true/false)'), policyVersion: await line('policyVersion'),
          fenceEpoch: await line('fenceEpoch') }));
      } else if (cmd === 'pause') out(need().s.voluntaryPause());
      else if (cmd === 'drain') out(await need().r.drain());
      else if (cmd === 'census') out(await need().r.census());
      else if (cmd === 'proofs') out(await need().r.takeProofs());
      else if (cmd === 'resume-day') out(need().s.resumeDay());
      else if (cmd === 'resume-pause') out(need().s.resumeVoluntary());
      else if (cmd === 'export') { if (session) out(save() ? 'RECEIPT_WRITTEN' : 'RECEIPT_NOT_PERSISTED'); continue; }
      else if (cmd === 'quit') {
        finalize();
        if (session && (session.closureState === 'PENDING' || session.voluntary === 'PENDING')) out('WARNING_CLOSURE_PENDING');
        return persisted ? 0 : 1;
      }
      save();
    } catch (e) {
      if (e instanceof Aborted) { finalize(); out('SESSION_ENDED_BY_CTRL_C'); return 130; }
      out((e as { fixed?: string; code?: string }).fixed ?? (e as { code?: string }).code ?? codeOf(e, 'INPUT_REJECTED'));
      if (session && cmd !== 'export' && cmd !== 'quit') save();
    }
  }
}
