// R-EVAL instrument revision CLI (rs-c brief B; local only, UNADMITTED). There is NO live flag, no key/env input and no network
// path beyond the owner's two measured unix sockets.
//   node scripts/reval-instrument/cli.ts artifact-check
//   node scripts/reval-instrument/cli.ts session --owner-config <abs path> --receipt-dir <dir>      (TTY only)
// The revision's fail-closed network guard (only the owner's two unix sockets, named once) is installed FIRST; every other module loads afterwards via dynamic import. For
// `session` the TTY is put in RAW mode (kernel echo off) BEFORE those imports; a terminal that cannot be made raw fails closed.
// Exit 0 = ok, 1 = check failed, 2 = usage. Errors print fixed codes only.
import { installInstrumentGuard } from './net-guard.ts';

installInstrumentGuard();
const USAGE = 'USAGE: cli.ts artifact-check | session --owner-config <abs path> --receipt-dir <dir> (no live mode exists)\n';
const [command, ...flags] = process.argv.slice(2);
const finish = (code: number): void => { process.stdout.write('', () => process.exit(code)); };

async function main(): Promise<number> {
  if (command === 'artifact-check' && flags.length === 0) {
    const { verifyRevision } = await import('./identity.ts');
    const r = verifyRevision();
    process.stdout.write(`${JSON.stringify({ command, ok: r.snapshot.ok, liveAdmissionReadiness: 'BLOCKED', liveAcceptanceEligible: false, drift: r.snapshot.drift,
      adminDeltaPaths: r.snapshot.adminDeltaPaths, filesChecked: r.snapshot.filesChecked, identity: r.snapshot.identity, revision: r.revision }, null, 2)}\n`);
    return r.snapshot.ok ? 0 : 1;
  }
  if (command === 'session' && flags.length === 4 && flags[0] === '--owner-config' && flags[2] === '--receipt-dir' && !flags[1]!.startsWith('--') && !flags[3]!.startsWith('--')) {
    let armedPrior: boolean | undefined;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      armedPrior = process.stdin.isRaw === true;
      try { process.stdin.setRawMode(true); } catch { /* checked below */ }
      if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); return 2; }
    }
    const restore = (): void => { if (armedPrior === false) { try { process.stdin.setRawMode(false); } catch { /* terminal gone */ } } };
    let operator: typeof import('./operator.ts');
    try { operator = await import('./operator.ts'); } catch (e) { restore(); throw e; }
    return operator.runInstrumentSession(flags[1]!, flags[3]!, { input: process.stdin, output: process.stdout, signals: true, armedPrior });
  }
  process.stderr.write(USAGE);
  return 2;
}
finish(await main());
