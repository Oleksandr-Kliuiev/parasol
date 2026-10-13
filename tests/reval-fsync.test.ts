import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// R-EVAL RS-D-C (rs-d brief C §1.5; carried since RS-C-B: "macOS fsync is not F_FULLFSYNC"): MEASURED, not assumed. A DYLD interposer
// (built here with the system clang; Homebrew node is ad-hoc signed, so DYLD_INSERT_LIBRARIES applies) logs every fcntl(F_FULLFSYNC=51 /
// F_BARRIERFSYNC=85) and fsync() of a child node that runs the REAL durable paths: C's terminal journal append (a new file: directory +
// file) and the instrument's receipt writer (`durableWrite`: temp file + directory). Every durability point must reach F_FULLFSYNC.
// darwin/arm64 only; synthetic files in a temp directory.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INTERPOSER = `
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void note(const char *s) { const char *o = getenv("FSYNC_PROBE_FD"); if (o) write(atoi(o), s, strlen(s)); }
int probe_fcntl(int fd, int cmd, ...) { va_list ap; va_start(ap, cmd); void *arg = va_arg(ap, void *); va_end(ap);
  if (cmd == F_FULLFSYNC) note("F_FULLFSYNC\\n"); else if (cmd == 85) note("F_BARRIERFSYNC\\n");
  return fcntl(fd, cmd, arg); }
int probe_fsync(int fd) { note("FSYNC\\n"); return fsync(fd); }
__attribute__((used)) static struct { const void *n; const void *o; } interposers[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)probe_fcntl, (const void *)fcntl }, { (const void *)probe_fsync, (const void *)fsync } };
`;
const CHILD = (dir: string) => `
import { writeSync } from 'node:fs';
import { TerminalJournal } from ${JSON.stringify(join(ROOT, 'packages/reval/eval-journal.ts'))};
import { durableWrite } from ${JSON.stringify(join(ROOT, 'scripts/reval-instrument/receipt.ts'))};
import { terminal } from ${JSON.stringify(join(ROOT, 'tests/support/reval-eval-fixtures.ts'))};
const mark = (s) => writeSync(3, s + '\\n');
mark('JOURNAL'); new TerminalJournal(${JSON.stringify(join(dir, 'reval-journal.jsonl'))}).save(terminal(), { serverBootId: ${JSON.stringify(randomUUID())}, receivedAt: '2026-10-13T10:00:00.000Z' });
mark('RECEIPT'); durableWrite(${JSON.stringify(dir)}, 'REVAL_TEST.json', '{}\\n');
mark('END');
`;

test('macOS durability: C\'s journal append and the instrument receipt write reach fcntl(F_FULLFSYNC) for every fsync (libuv on Apple)', { skip: !darwin && 'darwin/arm64 only', timeout: 60_000 }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reval-fsync-')));
  writeFileSync(join(dir, 'interpose.c'), INTERPOSER);
  const cc = spawnSync('/usr/bin/clang', ['-dynamiclib', '-O2', '-Wall', '-Werror', '-o', join(dir, 'interpose.dylib'), join(dir, 'interpose.c')], { encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr);
  const script = join(dir, 'child.ts'); writeFileSync(script, CHILD(dir));
  // fd 3 carries both the interposer's lines and the child's section marks, in order.
  const r = spawnSync(realpathSync(process.execPath), ['--experimental-strip-types', '--no-warnings', script], { encoding: 'utf8', cwd: ROOT,
    env: { DYLD_INSERT_LIBRARIES: join(dir, 'interpose.dylib'), FSYNC_PROBE_FD: '3', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, r.stderr);
  const lines = String(r.output[3]).trim().split('\n');
  const section = (from: string, to: string) => lines.slice(lines.indexOf(from) + 1, lines.indexOf(to));
  assert.deepEqual(section('JOURNAL', 'RECEIPT'), ['F_FULLFSYNC', 'F_FULLFSYNC'], 'journal: the new file\'s directory, then the appended line');
  assert.deepEqual(section('RECEIPT', 'END'), ['F_FULLFSYNC', 'F_FULLFSYNC'], 'receipt: the temp file, then the directory after the rename');
  assert.ok(!lines.includes('FSYNC') && !lines.includes('F_BARRIERFSYNC'), 'never the weaker fsync()/barrier fallback on this file system');
});
