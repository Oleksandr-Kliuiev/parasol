import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, childrenOf } from './reval-pty.ts';

/**
 * TEST-ONLY live pseudo-terminal for an interactive raw-mode tool (RS-C-B instrument revision): the same stdlib-only system
 * Python relay as reval-eval-process.ts (kept there byte-unchanged as accepted RS-C-A support), typed lines/pastes in, output
 * patterns awaited from a 0600 transcript file.
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

/** A live PTY (same Python relay) for an interactive raw-mode tool: type lines/pastes, wait for output patterns (RS-C-B). */
export class LiveTty {
  readonly child: ChildProcess; private readonly outPath: string; private cursor = 0;
  constructor(dir: string, entry: string, args: readonly string[], name: string) {
    this.outPath = join(dir, `${name}-pty-output.txt`); writeFileSync(this.outPath, '', { mode: 0o600 });
    const out = openSync(this.outPath, 'a');
    this.child = spawn('/usr/bin/python3', ['-I', '-c', RELAY, process.execPath, entry, ...args], { stdio: ['pipe', out, out], env: { PATH: '/usr/bin:/bin', TERM: 'dumb' } });
  }
  get transcript(): string { return readFileSync(this.outPath, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); }
  /** One line (raw mode: Enter is CR). */
  type(text: string): void { this.child.stdin!.write(`${text}\r`); }
  /** One paste ended by Ctrl-D. */
  paste(text: string): void { this.child.stdin!.write(`${text}\x04`); }
  /** The next match of `re` after the previous match; advances past it. */
  async expect(re: RegExp, ms = 20000): Promise<RegExpMatchArray> {
    const t = performance.now();
    for (;;) {
      const rest = this.transcript.slice(this.cursor);
      const m = rest.match(re);
      if (m && m.index !== undefined) { this.cursor += m.index + m[0].length; return m; }
      if (performance.now() - t > ms) throw new Error(`no ${re} in: ${rest.slice(-600).replace(/[^\x20-\x7e\n]/g, '')}`);
      await new Promise(r => setTimeout(r, 10));
    }
  }
  async stop(graceMs = 5000): Promise<{ forced: number[] }> {
    const tree = (pid: number): number[] => childrenOf(pid).flatMap(c => [c, ...tree(c)]);
    const all = tree(this.child.pid!);
    for (const p of childrenOf(this.child.pid!)) { try { process.kill(p, 'SIGHUP'); } catch { /* gone */ } }
    const t = Date.now();
    while (Date.now() - t < graceMs && all.some(alive)) await new Promise(r => setTimeout(r, 50));
    const forced = all.filter(alive);
    for (const p of forced) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    return { forced };
  }
}

