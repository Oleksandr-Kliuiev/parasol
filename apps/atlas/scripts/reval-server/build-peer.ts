// Builds the R-EVAL RS-A native peer helper (brief §2) with the FIXED command
//   /usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror -o <dir>/reval-peer native/reval-peer/peer.c -lbsm
// into dist/native (gitignored) or the directory given as the only argument (tests use a realpath temp dir). The basename
// is fixed: the arm64 ad-hoc code-signature identifier derives from it, which keeps two clean builds comparable. Prints
// only the output path and its sha256 (the owner pins that hash in the owner config). Darwin arm64 only; no install.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PEER_BASENAME = 'reval-peer';
const root = fileURLToPath(new URL('../../', import.meta.url));

export function buildPeer(outDir: string): { path: string; sha256: string } {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('reval-peer builds on darwin/arm64 only');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dir = realpathSync(outDir);
  const out = join(dir, PEER_BASENAME);
  const result = spawnSync('/usr/bin/clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', out, join(root, 'native/reval-peer/peer.c'), '-lbsm'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  if (result.status !== 0) throw new Error(`clang failed (${result.status}): ${(result.stderr || '').slice(0, 2000)}`);
  return { path: out, sha256: createHash('sha256').update(readFileSync(out)).digest('hex') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const built = buildPeer(process.argv[2] ?? join(root, 'dist/native'));
  console.log(`${built.path} sha256=${built.sha256}`);
}
