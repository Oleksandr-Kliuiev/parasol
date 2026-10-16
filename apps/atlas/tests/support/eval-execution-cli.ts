// Test composition only: current CLI and guard with verified historical artifact input.
import { installNetworkGuard } from '../../scripts/ask-remote-eval/net-guard.ts';
installNetworkGuard();
let armedPrior: boolean | undefined;
const session = process.argv[2] === 'session' && process.argv.length === 5 && process.argv[3] === '--receipt-dir' && !process.argv[4]!.startsWith('--');
if (session && process.stdin.isTTY && process.stdout.isTTY) {
  armedPrior = process.stdin.isRaw === true;
  try { process.stdin.setRawMode(true); } catch { /* checked below */ }
  if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); process.exit(2); }
}
try {
  const { runCli } = await import('../../scripts/ask-remote-eval-execution/cli-main.ts');
  const { testArtifacts } = await import('./reval-history.ts');
  const code = await runCli(process.argv.slice(2), testArtifacts, armedPrior);
  process.stdout.write('', () => process.exit(code));
} finally {
  if (armedPrior === false && process.stdin.isRaw) process.stdin.setRawMode(false);
}
