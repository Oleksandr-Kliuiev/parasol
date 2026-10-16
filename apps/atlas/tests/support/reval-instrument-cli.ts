// Test composition only: current CLI and guard with verified historical artifact input.
import { installInstrumentGuard } from '../../scripts/reval-instrument/net-guard.ts';
installInstrumentGuard();
let armedPrior: boolean | undefined;
const session = process.argv[2] === 'session' && process.argv.length === 7 && process.argv[3] === '--owner-config' && process.argv[5] === '--receipt-dir' && !process.argv[4]!.startsWith('--') && !process.argv[6]!.startsWith('--');
if (session && process.stdin.isTTY && process.stdout.isTTY) {
  armedPrior = process.stdin.isRaw === true;
  try { process.stdin.setRawMode(true); } catch { /* checked below */ }
  if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); process.exit(2); }
}
try {
  const { runCli } = await import('../../scripts/reval-instrument/cli-main.ts');
  const { verifyTestRevision } = await import('./reval-history.ts');
  const code = await runCli(process.argv.slice(2), verifyTestRevision, armedPrior);
  process.stdout.write('', () => process.exit(code));
} finally {
  if (armedPrior === false && process.stdin.isRaw) process.stdin.setRawMode(false);
}
