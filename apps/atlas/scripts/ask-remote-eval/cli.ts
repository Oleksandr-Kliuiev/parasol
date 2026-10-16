// ASK-REMOTE R-EVAL OFFLINE package CLI. There is NO live mode, key, environment input or network path.
//   node --experimental-strip-types scripts/ask-remote-eval/cli.ts <command>
//   verify | harness | rehearse | guard-selftest | all [--write-receipt] | write-manifest | write-review-templates
// The fail-closed network guard is installed FIRST; every other module (including all production code) is loaded only
// afterwards through a dynamic import. Output is one safe JSON receipt on stdout; exit 0 = ok, 1 = check failed, 2 = usage.
import { installNetworkGuard } from './net-guard.ts';

installNetworkGuard();
const COMMANDS = ['verify', 'harness', 'rehearse', 'guard-selftest', 'all', 'write-manifest', 'write-review-templates'];
const [command, ...flags] = process.argv.slice(2);
const allowedFlags = command === 'all' ? ['--write-receipt'] : [];
if (command === undefined || !COMMANDS.includes(command) || flags.some(f => !allowedFlags.includes(f)) || new Set(flags).size !== flags.length) {
  process.stderr.write(`USAGE: cli.ts ${COMMANDS.join('|')} (only 'all' accepts --write-receipt; there is no live mode)\n`);
  process.exit(2);
}
const c = await import('./commands.ts');
const run: Record<string, () => Record<string, unknown> | Promise<Record<string, unknown>>> = {
  verify: c.verify, harness: c.harness, rehearse: c.rehearse, 'guard-selftest': c.guardSelftest, all: () => c.all(flags.includes('--write-receipt')),
  'write-manifest': c.writeManifest, 'write-review-templates': c.writeReviewTemplates
};
const out = await run[command]!();
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.ok === true ? 0 : 1);
