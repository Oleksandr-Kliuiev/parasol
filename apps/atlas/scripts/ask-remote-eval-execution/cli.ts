// R-EVAL EXECUTION instrument CLI (local only). There is NO --live flag, no key/env input, no network or paid call path.
//   node --experimental-strip-types scripts/ask-remote-eval-execution/cli.ts <command>
//   artifact-check                      immutable identity + live-admission blockers (exit 0 = identity verified)
//   rehearse [--write-receipt]          scripted OFFLINE fake-V2 rehearsal (SIMULATED) + deterministic replay
//   session --receipt-dir <dir>         interactive operator session (TTY only; UNADMITTED LOCAL OBSERVATION)
//   replay --receipt <file>             schema-check a saved receipt and replay its numeric/closure evidence (answers: unverifiable)
//   help
// The accepted fail-closed network guard is installed FIRST; every other module loads afterwards via dynamic import.
// Exit 0 = ok, 1 = check failed, 2 = usage. Errors print fixed codes only.
import { installNetworkGuard } from '../ask-remote-eval/net-guard.ts';

installNetworkGuard();
// Arm raw mode before loading the dispatcher or any artifact/corpus dependencies.
let armedPrior: boolean | undefined;
const session = process.argv[2] === 'session' && process.argv.length === 5 && process.argv[3] === '--receipt-dir' && !process.argv[4]!.startsWith('--');
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
