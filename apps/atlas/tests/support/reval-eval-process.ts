import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, checkResponse, decodeResponse, Sequence } from '../../packages/reval/envelope.ts';
import type { ConnectionBinding } from '../../packages/reval/envelope.ts';
import { decodeHandoffWelcome, decodeInstrumentWelcome } from '../../packages/reval/eval-wire.ts';
import { alive, childrenOf } from './reval-pty.ts';
import type { Result } from './reval-pty.ts';

/**
 * TEST-ONLY process drivers for the R-EVAL RS-C-A E2E (O → C → S plus the instrument I and the browser).
 *
 * LiveOwner: the owner CLI under a REAL pseudo-terminal whose input is typed DURING the session (PAIR needs the instrument's
 * C-/S-assigned connection IDs, known only after I connected). macOS /usr/bin/script cannot take a live pipe as its stdin, so a
 * tiny relay in the system Python (/usr/bin/python3 -I, standard library `pty.fork` only, no new package) allocates the PTY,
 * runs O as the session leader with that controlling terminal, copies the test's pipe into the PTY master and the PTY output
 * into a 0600 file polled for result lines (`OK <KIND> <json>`, `FAILURE <code>`, `LOCAL <code>`, `REFUSED <reason>` and O's
 * raw-terminal-only `SECRET PAIRING_NONCE <nonce> <expiresAt>`).
 *
 * InstrumentProcess: tests/support/reval-test-instrument.ts under /usr/bin/script (a real PTY; stdin /dev/null), commanded
 * over a private side socket. The test builds and checks every frame.
 */
const RELAY = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
inp = True
while True:
    r = select.select([fd] + ([0] if inp else []), [], [])[0]
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            d = b''
        if not d:
            break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d:
            inp = False
        else:
            while d:
                d = d[os.write(fd, d):]
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st))
`;
const RESULT = /(?:OK [A-Z_]+ \{.*\}|FAILURE [A-Z_]+|LOCAL [A-Z_]+|REFUSED [A-Z_]+|SECRET PAIRING_NONCE [A-Za-z0-9_-]{43} \S+)$/;
export class LiveOwner {
  readonly child: ChildProcess; readonly results: Result[] = [];
  private readonly outPath: string; private seen = 0; private readonly timer: ReturnType<typeof setInterval>;
  constructor(dir: string, entry: string, args: readonly string[]) {
    this.outPath = join(dir, 'live-pty-output.txt'); writeFileSync(this.outPath, '', { mode: 0o600 });
    const out = openSync(this.outPath, 'a');
    this.child = spawn('/usr/bin/python3', ['-I', '-c', RELAY, process.execPath, entry, ...args], { stdio: ['pipe', out, out], env: { PATH: '/usr/bin:/bin', TERM: 'dumb' } });
    this.timer = setInterval(() => this.poll(), 5);
    this.child.once('exit', () => { this.poll(); clearInterval(this.timer); });
  }
  get transcript(): string { return readFileSync(this.outPath, 'utf8'); }
  private poll(): void {
    const lines = this.transcript.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n|\r/).slice(0, -1);
    const found = lines.map(l => l.trimEnd().match(RESULT)?.[0]).filter((l): l is string => l !== undefined);
    for (; this.seen < found.length; this.seen += 1) this.results.push({ line: found[this.seen]!, at: performance.now() });
  }
  async prompt(ms = 20000): Promise<void> {
    const t = performance.now();
    while (!this.transcript.includes('reval> ')) { if (performance.now() - t > ms) throw new Error(`no prompt: ${this.transcript.slice(-300)}`); await new Promise(r => setTimeout(r, 10)); }
  }
  /** Types one command and waits for its result line(s): `count` lines (PAIR success prints PAIR_ACK and the SECRET line). */
  async type(line: string, count = 1, ms = 20000): Promise<string[]> {
    const from = this.results.length;
    this.child.stdin!.write(`${line}\n`);
    const t = performance.now();
    while (this.results.length < from + count) {
      if (performance.now() - t > ms) throw new Error(`no result for ${line.split(' ')[0]}: ${this.transcript.slice(-400).replace(/[^\x20-\x7e\n]/g, '')}`);
      if (this.results.length > from && /^(FAILURE|LOCAL|REFUSED)/.test(this.results[from]!.line)) break;
      await new Promise(r => setTimeout(r, 5));
    }
    return this.results.slice(from).map(r => r.line);
  }
  /** O's graceful SIGHUP path, then SIGKILL of anything still alive in its tree after `graceMs` (reported). */
  async stop(graceMs = 7000): Promise<{ forced: number[] }> {
    clearInterval(this.timer);
    const tree = (pid: number): number[] => childrenOf(pid).flatMap(c => [c, ...tree(c)]);
    const relay = this.child.pid!; const owners = childrenOf(relay); const all = tree(relay);
    for (const o of owners) { try { process.kill(o, 'SIGHUP'); } catch { /* gone */ } }
    const t = Date.now();
    while (Date.now() - t < graceMs && all.some(alive)) await new Promise(r => setTimeout(r, 50));
    const forced = all.filter(alive);
    for (const p of forced) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    return { forced };
  }
}

export class InstrumentProcess {
  readonly child: ChildProcess; pid = 0;
  private side: Socket | null = null; private nextId = 0;
  private readonly waiting = new Map<number, (v: any) => void>();
  private constructor(child: ChildProcess) { this.child = child; }
  static async start(dir: string): Promise<InstrumentProcess> {
    const sidePath = join(dir, 'instrument-side.sock');
    const server = createServer();
    await new Promise<void>(r => server.listen(sidePath, r));
    const entry = fileURLToPath(new URL('./reval-test-instrument.ts', import.meta.url));
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', process.execPath, '--no-warnings', entry, sidePath], { stdio: ['ignore', 'ignore', 'ignore'],
      env: { PATH: '/usr/bin:/bin', TERM: 'dumb' } });
    const p = new InstrumentProcess(child);
    const socket = await new Promise<Socket>((resolve, reject) => { server.once('connection', resolve); setTimeout(() => reject(new Error('instrument never connected')), 15000); });
    server.close();
    p.side = socket;
    const lines = createInterface({ input: socket });
    const first = new Promise<any>(r => lines.once('line', l => r(JSON.parse(l))));
    p.pid = (await first).pid;
    lines.on('line', l => { const m = JSON.parse(l); const w = p.waiting.get(m.id); if (w) { p.waiting.delete(m.id); w(m); } });
    return p;
  }
  private cmd(o: Record<string, unknown>): Promise<any> {
    const id = ++this.nextId;
    return new Promise(resolve => { this.waiting.set(id, resolve); this.side!.write(`${JSON.stringify({ ...o, id })}\n`); });
  }
  async open(name: string, path: string): Promise<void> { const r = await this.cmd({ cmd: 'open', name, path }); if (!r.ok) throw new Error(`open ${r.error}`); }
  async send(name: string, frame: unknown): Promise<void> { await this.cmd({ cmd: 'send', name, frame }); }
  /** The next frame on `name`, or `{ error: <ChannelClosed reason> }`. */
  async next(name: string, ms = 5000): Promise<any> { const r = await this.cmd({ cmd: 'next', name, ms }); return 'frame' in r ? r.frame : { error: r.error }; }
  async close(name: string): Promise<void> { await this.cmd({ cmd: 'close', name }); }
  async stop(): Promise<void> {
    this.side?.end();
    const kids = childrenOf(this.child.pid!);
    await new Promise(r => setTimeout(r, 200));
    for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

/** The instrument's control connection to C (06 envelopes as principal I) and its handoff connection to S. */
export async function instrument(dir: string, r: { registrationId: string; databaseInstanceId: string }) {
  const inst = await InstrumentProcess.start(dir);
  try { return await connectInstrument(inst, dir, r); } catch (e) { await inst.stop(); throw e; }
}
async function connectInstrument(inst: InstrumentProcess, dir: string, r: { registrationId: string; databaseInstanceId: string }) {
  const sock = (name: string) => join(dir, name);
  for (let i = 0; i < 200 && !(existsSync(sock('reval-instrument.sock')) && existsSync(sock('reval-handoff.sock'))); i += 1) await new Promise(res => setTimeout(res, 50));
  await inst.open('ctl', sock('reval-instrument.sock'));
  const helloNonce = randomUUID();
  await inst.send('ctl', { contractVersion: 'RevalInstrumentHelloV1', kind: 'CONTROL', helloNonce });
  const w = decodeInstrumentWelcome(await inst.next('ctl'));
  assert.equal(w.helloNonce, helloNonce);
  await inst.open('ho', sock('reval-handoff.sock'));
  await inst.send('ho', { contractVersion: 'RevalHandoffHelloV1', helloNonce, controlConnectionId: w.connectionId });
  const hw = decodeHandoffWelcome(await inst.next('ho'));
  assert.deepEqual([hw.controlConnectionId, hw.serverBootId], [w.connectionId, w.serverBootId]);
  const binding: ConnectionBinding = { registrationId: r.registrationId, serverBootId: w.serverBootId, connectionId: w.connectionId };
  const send = new Sequence(); const recv = new Sequence(); let hoSeq = 0n;
  return { inst, controlId: w.connectionId, handoffId: hw.connectionId, serverBootId: w.serverBootId,
    async request(operation: string, payload: Record<string, unknown>): Promise<{ kind: string; payload: any; emitter: string }> {
      const out = { challenge: randomUUID(), sequence: send.take(), operation: operation as never };
      await inst.send('ctl', buildRequest(binding, out.challenge, out.sequence, out.operation, payload));
      const res = decodeResponse(await inst.next('ctl', 5000));
      assert.equal(checkResponse(binding, recv, out, res, res.emitter, r.databaseInstanceId), null);
      return { kind: res.kind, payload: res.payload, emitter: res.emitter };
    },
    async handoff(frame: Record<string, unknown>) { hoSeq += 1n; await inst.send('ho', { ...frame, connectionId: hw.connectionId, sequence: String(hoSeq) }); },
  };
}
