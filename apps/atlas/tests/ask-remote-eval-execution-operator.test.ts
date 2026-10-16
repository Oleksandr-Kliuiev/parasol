import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityV2 } from '../packages/ask/remote/contracts.ts';
import { loadContext } from '../scripts/ask-remote-eval-execution/corpus.ts';
import { fakeUuid } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { runOperatorSession } from '../scripts/ask-remote-eval-execution/operator.ts';
import { replayNumeric } from '../scripts/ask-remote-eval-execution/replay.ts';
import { ADMISSION_ID, START } from '../scripts/ask-remote-eval-execution/rehearsal.ts';

// Operator session with an INJECTED TTY (test harness, not a live journey): every prompt receives scripted raw chunks, split
// at awkward byte boundaries. Proves echo-off for commands/metadata/pastes, multibyte-safe pastes, the GO/NO-GO gate after a
// persisted in-flight receipt, Ctrl-C → ABANDONED_IN_FLIGHT, and stop-on-save-failure. No browser, server or network.

type Item = string | Buffer[] | ((out: string) => string | Buffer[]);
class FakeIn extends EventEmitter {
  isTTY = true; isRaw = false; readonly rawLog: boolean[] = []; readonly #items: Item[]; readonly #out: { text: string }; readonly #rawWorks: boolean;
  constructor(items: Item[], out: { text: string }, rawWorks = true) { super(); this.#items = items; this.#out = out; this.#rawWorks = rawWorks; }
  setRawMode(on: boolean): this { this.rawLog.push(on); if (this.#rawWorks) this.isRaw = on; return this; } resume(): this { return this; } pause(): this { return this; }
  override on(event: string, f: (...a: any[]) => void): this {
    super.on(event, f);
    if (event === 'data') setImmediate(() => {
      const item = this.#items.shift() ?? '\x03';
      const v = typeof item === 'function' ? item(this.#out.text) : item;
      for (const chunk of typeof v === 'string' ? [Buffer.from(v, 'utf8')] : v) this.emit('data', chunk);
    });
    return this;
  }
}
const ctx = loadContext();
const split = (text: string, size: number): Buffer[] => { const b = Buffer.from(text, 'utf8'); const out: Buffer[] = []; for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size)); return out; };
const MARK = 'MARKER-ПРОВЕРКА-7781';

async function session(items: Item[], dir: string, rawWorks = true) {
  const out = { text: '' }; let mono = 5_000.25; const input = new FakeIn(items, out, rawWorks);
  const code = await runOperatorSession(dir, { input, output: { isTTY: true, write: (s: string) => { out.text += s; } },
    clock: () => ({ utcMs: START + 60_000.5, monoMs: (mono += 333.333) }), nonce: () => 'c0ffee12', signals: false });
  return { code, out: out.text, rawLog: input.rawLog };
}
const first = ctx.corpus.order[0]!; const c = ctx.corpus.cases.get(first)!;
const focus = ctx.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus ?? 'none';
const capability = (): Item[] => ['capability\r', '200\r', `${fakeUuid(`cap:${Math.random()}`)}\r`, [...split(JSON.stringify(capabilityV2(ADMISSION_ID, '7')), 7), Buffer.from([4])]];
const admission: Item[] = ['admission\r', `${ADMISSION_ID}\r`, '2026-10-12T00:00:00Z\r', '2026-10-15T00:00:00Z\r', '2000000\r', '10000000\r', '40\r', '10\r'];
const toGo: Item[] = [...admission, 'confirm\r', `${MARK}\r`, '7\r', 'confirm\r', `${ADMISSION_ID}\r`, '7\r', 'counters\r', '0\r', '0\r', ...capability(),
  'stage\r', `${focus}\r`, [...split(`\x1b[200~${c.question.replace(/\n/g, '\r')}\x1b[201~`, 3), Buffer.from([4])],
  'consent\r', 'c0ffee12\r', 'YES\r'];
const receiptIn = (dir: string) => JSON.parse(readFileSync(join(dir, `REVAL_EXECUTION_${ADMISSION_ID}.json`), 'utf8')) as Record<string, any>;

test('echo-off everywhere: a marker typed as command or metadata never reaches output; multibyte split paste stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-op-'));
  try {
    const { code, out, rawLog } = await session([`${MARK}\r`, ...toGo, 'submit\r', 'quit\r'], dir);
    assert.equal(code, 0);
    assert.deepEqual(rawLog, [true, false], 'raw armed once before the banner for the whole session, restored once at exit');
    assert.ok(!out.includes('MARKER') && !out.includes('ПРОВЕРКА'), 'no untrusted input is echoed');
    assert.ok(!out.includes(c.question.slice(0, 20)), 'the question is never printed');
    assert.match(out, /UNKNOWN_COMMAND/); assert.match(out, /ADMISSION_ID_INVALID/); assert.match(out, /\nSTAGED\n/); assert.match(out, /\nCONSENTED\n/);
    assert.match(out, new RegExp(`GO_CLICK_ASK_NOW ${first}`));
    assert.match(out, /ABANDONED_IN_FLIGHT/, 'quit with a case in flight records it');
    const r = receiptIn(dir);
    assert.equal(r.run.state, 'TERMINAL_INCOMPLETE'); assert.equal(r.run.localReason, 'ABANDONED_IN_FLIGHT'); assert.equal(r.run.closure, 'PENDING');
    assert.equal(r.run.consumed, 1); assert.equal(r.provenance.utcClock, 'LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED');
    assert.equal(replayNumeric(r).status, 'VERIFIED_SAVED_ARITHMETIC');
    const restart = await session([...admission], dir);
    assert.match(restart.out, /RUN_ALREADY_STARTED_OR_DIR_UNWRITABLE/, 'the lock keeps a restarted process from reusing case IDs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GO only after a persisted in-flight receipt; any blocked gate says DO_NOT_CLICK; Ctrl-C abandons and saves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-op-'));
  try {
    let inFlightSeen: Record<string, unknown> | null = null;
    const { code, out } = await session([...admission, 'submit\r', ...toGo.slice(admission.length), 'submit\r',
      (o: string) => { if (o.includes('GO_CLICK_ASK_NOW')) inFlightSeen = receiptIn(dir).run.inFlight; return '\x03'; }], dir);
    assert.equal(code, 130);
    assert.match(out, /BLOCKED_NO_COUNTERS DO_NOT_CLICK|BLOCKED DO_NOT_CLICK/);
    assert.deepEqual(inFlightSeen, { caseId: first, submittedPolicyVersion: '7', liability: 'UNKNOWN' }, 'the receipt on disk showed the in-flight case at GO');
    assert.match(out, /SESSION_ENDED_BY_CTRL_C/);
    const r = receiptIn(dir);
    assert.equal(r.run.localReason, 'ABANDONED_IN_FLIGHT'); assert.equal(r.cases[0].outcome, 'ABANDONED_IN_FLIGHT'); assert.equal(r.cases[0].liability, 'UNKNOWN');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('save failure stops supervision: DISPATCH without a persisted receipt becomes DO_NOT_CLICK + abandoned; later commands blocked', async () => {
  if (process.getuid?.() === 0) return; // a read-only directory does not stop root
  const dir = mkdtempSync(join(tmpdir(), 'reval-op-'));
  try {
    const { out } = await session([...toGo, (o: string) => { void o; chmodSync(dir, 0o500); return 'submit\r'; }, 'counters\r',
      (o: string) => { void o; chmodSync(dir, 0o700); return 'export\r'; }, 'quit\r'], dir);
    assert.match(out, /RECEIPT_WRITE_FAILED RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK/);
    assert.match(out, /ABANDONED_IN_FLIGHT\nDO_NOT_CLICK/);
    assert.ok(!/GO_CLICK_ASK_NOW RE-/.test(out), 'no GO line was printed');
    assert.match(out, /BLOCKED_RECEIPT_NOT_PERSISTED_STOP_DO_NOT_CLICK/);
    assert.match(out, /RECEIPT_WRITTEN/);
    assert.equal(receiptIn(dir).run.localReason, 'ABANDONED_IN_FLIGHT');
    assert.ok(!readFileSync(join(dir, `REVAL_EXECUTION_${ADMISSION_ID}.json`), 'utf8').includes(c.question.slice(0, 20)));
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); assert.equal(existsSync(dir), false); }
});

test('RC2 R6: raw mode is armed before any output and kept; unavailable raw mode fails closed; type-ahead in one chunk is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-op-'));
  try {
    const failed = await session(['help\r'], dir, false);
    assert.equal(failed.code, 2); assert.equal(failed.out, '', 'nothing (no banner, no claims) is displayed without raw mode');
    const ahead = await session([`help\r${MARK}\rquit\r`], dir);
    assert.equal(ahead.code, 0); assert.deepEqual(ahead.rawLog, [true, false]);
    assert.match(ahead.out, /\[help\][\s\S]*UNKNOWN_COMMAND[\s\S]*\[quit\]/, 'type-ahead after a terminator is consumed by the next prompts');
    assert.ok(!ahead.out.includes('MARKER'));
    const out = { text: '' }; const input = new FakeIn(['quit\r'], out); input.isRaw = true;
    assert.equal(await runOperatorSession(dir, { input, output: { isTTY: true, write: (x: string) => { out.text += x; } }, signals: false, armedPrior: true }), 0);
    assert.deepEqual(input.rawLog, [], 'armed by the CLI and prior raw: never switched off');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
