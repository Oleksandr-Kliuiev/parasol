// R-EVAL instrument revision CLI (rs-c brief B; local only, UNADMITTED). There is NO live flag, no key/env input and no network
// path beyond the owner's two measured unix sockets.
//   node scripts/reval-instrument/cli.ts artifact-check
//   node scripts/reval-instrument/cli.ts session --owner-config <abs path> --receipt-dir <dir>      (TTY only)
// The revision's fail-closed network guard (only the owner's two unix sockets, named once) is installed FIRST; every other module loads afterwards via dynamic import. For
// `session` the TTY is put in RAW mode (kernel echo off) BEFORE those imports; a terminal that cannot be made raw fails closed.
// Exit 0 = ok, 1 = check failed, 2 = usage. Errors print fixed codes only.
import { installInstrumentGuard } from './net-guard.ts';

installInstrumentGuard();
// Arm raw mode before loading the dispatcher or any artifact/corpus dependencies.
let armedPrior: boolean | undefined;
const session = process.argv[2] === 'session' && process.argv.length === 7 && process.argv[3] === '--owner-config' && process.argv[5] === '--receipt-dir' && !process.argv[4]!.startsWith('--') && !process.argv[6]!.startsWith('--');
if (session && process.stdin.isTTY && process.stdout.isTTY) {
  armedPrior = process.stdin.isRaw === true;
  try { process.stdin.setRawMode(true); } catch { /* checked below */ }
  if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); process.exit(2); }
}
try {
  const { runCli } = await import('./cli-main.ts');
  const code = await runCli(process.argv.slice(2), undefined, armedPrior);
  process.stdout.write('', () => process.exit(code));
} finally {
  if (armedPrior === false && process.stdin.isRaw) process.stdin.setRawMode(false);
}
