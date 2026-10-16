// Dispatch shared by the production entry and explicit test composition.
import { verifyRevision } from './identity.ts';
const USAGE = 'USAGE: cli.ts artifact-check | session --owner-config <abs path> --receipt-dir <dir> (no live mode exists)\n';

export async function runCli(argv: string[], verify: typeof verifyRevision = verifyRevision, initialRaw?: boolean): Promise<number> {
  const [command, ...flags] = argv;
  if (command === 'artifact-check' && flags.length === 0) {
    const r = verify();
    process.stdout.write(`${JSON.stringify({ command, ok: r.snapshot.ok, liveAdmissionReadiness: 'BLOCKED', liveAcceptanceEligible: false, drift: r.snapshot.drift,
      adminDeltaPaths: r.snapshot.adminDeltaPaths, filesChecked: r.snapshot.filesChecked, identity: r.snapshot.identity, revision: r.revision }, null, 2)}\n`);
    return r.snapshot.ok ? 0 : 1;
  }
  if (command === 'session' && flags.length === 4 && flags[0] === '--owner-config' && flags[2] === '--receipt-dir' && !flags[1]!.startsWith('--') && !flags[3]!.startsWith('--')) {
    let armedPrior: boolean | undefined;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      armedPrior = initialRaw ?? process.stdin.isRaw === true;
      try { process.stdin.setRawMode(true); } catch { /* checked below */ }
      if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); return 2; }
    }
    const restore = (): void => { if (armedPrior === false) { try { process.stdin.setRawMode(false); } catch { /* terminal gone */ } } };
    let operator: typeof import('./operator.ts');
    try { operator = await import('./operator.ts'); } catch (e) { restore(); throw e; }
    return operator.runInstrumentSession(flags[1]!, flags[3]!, { input: process.stdin, output: process.stdout, signals: true, armedPrior }, verify);
  }
  process.stderr.write(USAGE);
  return 2;
}
