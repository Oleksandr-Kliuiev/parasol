// CLI dispatch; the entry point installs the network guard before loading this module.
import { productionArtifacts } from './corpus.ts';
import type { ArtifactAccess } from './corpus.ts';
const USAGE = 'USAGE: cli.ts artifact-check | rehearse [--write-receipt] | session --receipt-dir <dir> | replay --receipt <file> | help (no live mode exists)\n';
const usage = (): never => { process.stderr.write(USAGE); process.exit(2); };
const RECEIPT_PATH = new URL('../../docs/stage5/ask/remote/execution/rehearsal/EXECUTION_REHEARSAL_RECEIPT.json', import.meta.url);

export async function runCli(argv: string[], artifacts: ArtifactAccess = productionArtifacts, initialRaw?: boolean): Promise<number> {
  const [command, ...flags] = argv;
  if (command === 'help' && flags.length === 0) { process.stdout.write(USAGE); return 0; }
  if (command === 'artifact-check' && flags.length === 0) {
    const { admissionBlockers } = await import('./artifact.ts');
    const s = artifacts.verifyArtifact();
    process.stdout.write(`${JSON.stringify({ command, ok: s.ok, localUseReady: s.ok, liveAdmissionReadiness: 'BLOCKED', liveAcceptanceEligible: false,
      admissionBlockers: admissionBlockers(s), drift: s.drift, adminDeltaPaths: s.adminDeltaPaths, filesChecked: s.filesChecked, identity: s.identity,
      labelStatus: s.labelStatus, attestation: s.attestation }, null, 2)}\n`);
    return s.ok ? 0 : 1;
  }
  if (command === 'rehearse' && (flags.length === 0 || (flags.length === 1 && flags[0] === '--write-receipt'))) {
    const { rehearse } = await import('./rehearsal.ts');
    const { receiptIssues } = await import('../ask-remote-eval/evidence.ts');
    const result = rehearse(artifacts.loadContext());
    const issues = receiptIssues(result, artifacts.loadContext().cases);
    const safe = { ...result, ok: result.ok === true && issues.length === 0, receiptScan: issues.length === 0 ? 'CLEAN' : 'UNSAFE' };
    const text = `${JSON.stringify(safe, null, 2)}\n`;
    if (flags[0] === '--write-receipt' && issues.length === 0) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(new URL('./', RECEIPT_PATH), { recursive: true });
      writeFileSync(RECEIPT_PATH, text);
    }
    process.stdout.write(issues.length === 0 ? text : '{"command":"rehearse","ok":false,"receiptScan":"UNSAFE"}\n');
    return safe.ok ? 0 : 1;
  }
  if (command === 'session' && flags.length === 2 && flags[0] === '--receipt-dir' && typeof flags[1] === 'string' && !flags[1].startsWith('--')) {
    // Arm RAW mode (kernel echo off) BEFORE the dynamic imports and any banner/verification; the session restores the prior
    // mode at exit. A terminal that cannot be made raw fails closed. Non-TTY input is refused by the session itself.
    let armedPrior: boolean | undefined;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      armedPrior = initialRaw ?? process.stdin.isRaw === true;
      try { process.stdin.setRawMode(true); } catch { /* checked below */ }
      if (process.stdin.isRaw !== true) { process.stderr.write('TTY_RAW_MODE_UNAVAILABLE\n'); return 2; }
    }
    const restore = (): void => { if (armedPrior === false) { try { process.stdin.setRawMode(false); } catch { /* terminal gone */ } } };
    let operator: typeof import('./operator.ts');
    try { operator = await import('./operator.ts'); } catch (e) { restore(); throw e; }
    return operator.runOperatorSession(flags[1], { input: process.stdin, output: process.stdout, signals: true, armedPrior }, artifacts);
  }
  if (command === 'replay' && flags.length === 2 && flags[0] === '--receipt' && typeof flags[1] === 'string' && !flags[1].startsWith('--')) {
    const { readFileSync } = await import('node:fs');
    const { assertReceipt } = await import('./receipt.ts');
    const { replayNumeric } = await import('./replay.ts');
    let receipt: Record<string, any>; let schema = 'VALID';
    try { receipt = JSON.parse(readFileSync(flags[1], 'utf8')) as Record<string, any>; assertReceipt(receipt, artifacts.loadContext().cases); }
    catch { process.stdout.write('{"command":"replay","ok":false,"schema":"RECEIPT_UNREADABLE_OR_UNSAFE"}\n'); return 1; }
    const r = replayNumeric(receipt);
    const ok = r.status === 'VERIFIED_SAVED_ARITHMETIC' && receipt.replay.numeric === r.status;
    process.stdout.write(`${JSON.stringify({ command, ok, schema, numeric: r.status, failed: r.failed, livePerCase: receipt.replay.livePerCase })}\n`);
    return ok ? 0 : 1;
  }
  return usage();
}
