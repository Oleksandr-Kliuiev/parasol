// S2-LIVE pilot driver (docs/stage2/reviews/S2LIVE_OPERATIONAL_BRIEF_RC5.md, packages/ops/pilot/AGENTS.md). Direct invocation only:
//   node --experimental-strip-types scripts/stage2-live-pilot.ts --config /absolute/private/path/pilot.json
// No NODE_OPTIONS, --import/--require/--loader or test variables (refused before any I/O). Environment: ATLAS_RUNTIME_DATABASE_URL
// (confined runtime role), ATLAS_OPERATOR_TOKEN, the env:// credential the bound connection names and, for m365-directory /
// correlation, ATLAS_CORRELATION_CURSOR_SECRET_REF. One allowlisted accepted command per process, every vendor/Graph/token
// dispatch classified and recorded (metadata only) in the configured NEW receipts file. Prints one JSON object: statuses,
// counts, aliases and safe codes — never IDs, DTOs, tokens, cursors or URLs. It is NOT a live gate verdict.
// Exit code: 0 command ok and recording complete; 1 command not ok, projection refused or recording incomplete; 2 refused.
// Do not import scripts/ops.ts here: `bind` and every other command stay on the separate accepted CLI.
import { runPilot } from '../packages/ops/pilot/driver.ts';

let exitCode = 2;
let summary: unknown = { pilot: 'atlas-stage2-live-pilot', version: 1, status: 'REFUSED', safeErrorCode: 'UNEXPECTED_ERROR' };
try {
  const outcome = await runPilot({ argv: process.argv.slice(2), env: process.env, execArgv: process.execArgv });
  exitCode = outcome.exitCode; summary = outcome.summary;
} catch { /* the fixed summary above: no exception text leaves the process */ }
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = exitCode;
