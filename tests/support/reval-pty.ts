import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TEST-ONLY driver of an owner CLI under a REAL pseudo-terminal allocated by macOS /usr/bin/script (no new dependency).
 * macOS pipes/FIFOs are socket-backed and script accepts only a terminal, a regular file or /dev/null as its stdin, so the
 * session's typed lines are written up front to a 0600 regular file that script replays into the PTY (then ^D), and the
 * PTY output goes to a regular file polled with arrival times. Result lines: `OK <KIND> <json>`, `FAILURE <code>`,
 * `LOCAL <code>`, `REFUSED <reason>`. Inter-arrival times of consecutive results measure per-command latency.
 */
export interface Result { readonly line: string; readonly at: number }
export class PtySession {
  readonly child: ChildProcess;
  private readonly outPath: string;
  readonly results: Result[] = [];
  private seen = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly started = performance.now();
  static readonly PADDING = 3000;
  private padded = 0;
  constructor(dir: string, entry: string, args: readonly string[], lines: readonly string[]) {
    const input = join(dir, 'pty-input.txt'); this.outPath = join(dir, 'pty-output.txt');
    // Leading blank lines (each answered `REFUSED GRAMMAR`, skipped below) exceed the kernel TTY input queue, so script blocks on
    // the PTY master until O is actually reading and its end-of-file ^D can never overtake the commands.
    writeFileSync(input, `${'\n'.repeat(PtySession.PADDING)}${lines.map(l => `${l}\n`).join('')}`, { mode: 0o600 }); writeFileSync(this.outPath, '', { mode: 0o600 });
    const inFd = openSync(input, 'r'); const outFd = openSync(this.outPath, 'a');
    this.child = spawn('/usr/bin/script', ['-q', '/dev/null', process.execPath, entry, ...args], { stdio: [inFd, outFd, outFd], env: { PATH: '/usr/bin:/bin', TERM: 'dumb' } });
    this.timer = setInterval(() => this.poll(), 5);
    this.child.once('exit', () => { this.poll(); clearInterval(this.timer); });
  }
  get transcript(): string { return readFileSync(this.outPath, 'utf8'); }
  private poll(): void {
    const complete = this.transcript.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n|\r/).slice(0, -1);
    // O writes each result as one whole line; readline's echo of typed input may PREFIX it on the same terminal line.
    const found = complete.map(l => l.trimEnd().match(/(?:OK [A-Z_]+ \{.*\}|FAILURE [A-Z_]+|LOCAL [A-Z_]+|REFUSED [A-Z_]+)$/)?.[0]).filter((l): l is string => l !== undefined);
    const now = performance.now();
    for (; this.seen < found.length; this.seen += 1) {
      // A LOCAL line (C exited before any response: O's locally mapped code) may legitimately interleave with the padding.
      if (this.padded < PtySession.PADDING && !found[this.seen]!.startsWith('LOCAL ')) {
        if (found[this.seen] !== 'REFUSED GRAMMAR') throw new Error('PTY padding answered unexpectedly'); this.padded += 1; continue;
      }
      this.results.push({ line: found[this.seen]!, at: now });
    }
  }
  async waitFor(pred: (r: Result, i: number) => boolean, ms = 20000): Promise<number> {
    const t = performance.now();
    while (performance.now() - t < ms) { const i = this.results.findIndex(pred); if (i >= 0) return i; await new Promise(r => setTimeout(r, 5)); }
    throw new Error(`PTY wait timeout; tail: ${this.transcript.slice(-400).replace(/[^\x20-\x7e\n]/g, '')}`);
  }
  exited(ms: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise(r => { const t = setTimeout(() => r(false), ms); this.child.once('exit', () => { clearTimeout(t); r(true); }); });
  }
  /**
   * Ends the session and its WHOLE process tree. Killing the pty master (`script`) is not relied upon to hang O up: in this
   * harness O was observed to survive it with its controller (RC2 finding). O gets an explicit SIGHUP (its graceful path:
   * O closes the channel, C shuts S/E down and exits); anything still alive after `graceMs` is SIGKILLed and reported.
   */
  async stop(graceMs = 7000): Promise<{ forced: number[] }> {
    clearInterval(this.timer);
    const tree = (pid: number): number[] => childrenOf(pid).flatMap(c => [c, ...tree(c)]);
    const script = this.child.pid!;
    const owners = childrenOf(script); const all = tree(script);
    for (const o of owners) { try { process.kill(o, 'SIGHUP'); } catch { /* gone */ } }
    const t = Date.now();
    while (Date.now() - t < graceMs && all.some(alive)) await new Promise(r => setTimeout(r, 50));
    const forced = all.filter(alive);
    for (const p of forced) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    return { forced };
  }
}
/** Child pids of `pid` (pgrep -P). */
export function childrenOf(pid: number): number[] {
  try { return execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function waitGone(pids: readonly number[], ms: number): Promise<boolean> {
  const t = Date.now(); while (Date.now() - t < ms) { if (pids.every(p => !alive(p))) return true; await new Promise(r => setTimeout(r, 50)); } return pids.every(p => !alive(p));
}
