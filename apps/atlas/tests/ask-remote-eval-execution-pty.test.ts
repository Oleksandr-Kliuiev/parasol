import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RC2 Sol R6 regression with a REAL pseudo-terminal (the system `script` utility; no mocked setRawMode). The actual CLI
// session runs on a pty whose kernel would echo any typed byte while ECHO is on. Harmless markers are injected (1) right
// after the first banner line, i.e. during artifact/corpus verification, (2) as type-ahead in the same write as a command,
// (3) right after the admission values, while the session is constructed, the artifact re-hashed and the receipt fsync'd,
// and (4) a Ctrl-C byte during command processing. No marker may appear anywhere in the pty output; Ctrl-C must finalize.
// Offline only: no network, provider, DB or browser. Skipped (reported) only when no `script` utility exists.

const ADMISSION = '5e1f7a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const MARKERS = ['PTY-STARTUP-MARKER-Ж', 'PTY-TYPEAHEAD-MARKER-Щ', 'PTY-PROCESSING-MARKER-Ю'];
const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;

test('real pty: kernel echo stays off from startup verification through processing; Ctrl-C finalizes', { skip: hasScript ? false : 'NO_PTY_UTILITY_script' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-pty-'));
  const work = mkdtempSync(join(tmpdir(), 'reval-pty-io-'));
  const fifo = join(work, 'in'); const outFile = join(work, 'out');
  // `script` needs a real pipe(2) on stdin and a non-socket stdout (Node 'pipe' stdio and macOS FIFOs are sockets): feed it
  // `cat FIFO |` and capture the pty output in a file that is polled.
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
  const argv = [process.execPath, '--experimental-strip-types', '--no-warnings', 'tests/support/eval-execution-cli.ts', 'session', '--receipt-dir', dir].map(q).join(' ');
  const inner = process.platform === 'darwin' ? `script -q /dev/null ${argv}` : `script -q -e -c ${q(argv)} /dev/null`;
  // Own process group, so every failure path kills sh, cat, script and the session together.
  const child = spawn('sh', ['-c', `cat ${q(fifo)} | ${inner} > ${q(outFile)} 2>&1`], { stdio: 'ignore', detached: true });
  const killAll = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
  const writer = createWriteStream(fifo);
  let out = ''; let step = 0;
  const send = (s: string): void => { writer.write(Buffer.from(s, 'utf8')); };
  const values = [ADMISSION, '2026-10-12T00:00:00Z', '2026-10-15T00:00:00Z', '2000000', '10000000', '40', '10'];
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); killAll(); reject(new Error(`PTY_TEST_TIMEOUT step ${step}`)); }, 90_000);
      child.on('exit', code => { clearTimeout(timer); clearInterval(poll); resolve(code); });
      const poll = setInterval(() => {
        try { out = readFileSync(outFile, 'utf8'); } catch { return; }
        if (MARKERS.some(m => out.includes(m))) { clearInterval(poll); clearTimeout(timer); killAll(); reject(new Error(`MARKER_ECHOED step ${step}`)); return; }
        const prompts = out.split('reval>').length - 1;
        if (step === 0 && out.includes('R-EVAL EXECUTION INSTRUMENT')) { step = 1; send(`${MARKERS[0]}\r`); }
        else if (step === 1 && prompts >= 2) { step = 2; send(`help\r${MARKERS[1]}\r`); }
        else if (step === 2 && prompts >= 4) { step = 3; send(`admission\r${values.join('\r')}\r${MARKERS[2]}\r`); }
        else if (step === 3 && out.includes('ADMISSION_RECORDED_ATTESTED') && prompts >= 6) { step = 4; send('export\r\x03'); }
        else if (step === 4 && out.includes('SESSION_ENDED_BY_CTRL_C')) { step = 5; writer.end(); }
      }, 5);
    });
    out = readFileSync(outFile, 'utf8');
    assert.equal(step, 5, `all phases reached (${step})`);
    for (const m of MARKERS) assert.ok(!out.includes(m), `marker never echoed: ${m}`);
    assert.ok(!/PTY-|MARKER|[ЖЩЮ]/.test(out), 'no marker fragment in pty output');
    assert.match(out, /UNKNOWN_COMMAND/, 'markers were consumed as (rejected) commands, not echoed');
    assert.match(out, /SESSION_ENDED_BY_CTRL_C/);
    void exit; // `script` exit status differs by platform; the session's own end marker is asserted above
    const receipt = JSON.parse(readFileSync(join(dir, `REVAL_EXECUTION_${ADMISSION}.json`), 'utf8')) as Record<string, any>;
    assert.equal(receipt.runClass, 'UNADMITTED_LOCAL_OBSERVATION'); assert.equal(receipt.run.consumed, 0);
    assert.ok(existsSync(join(dir, `REVAL_EXECUTION_${ADMISSION}.lock`)));
  } finally {
    killAll();
    writer.destroy(); rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  }
});
