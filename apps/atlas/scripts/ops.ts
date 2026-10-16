// Operator CLI (docs/RUNBOOK.md):  npm run ops -- <command> [--flag value]…
//   bind --client C --connection N --system atera|huntress --tenant T --secret-ref env://NAME   explicit tenant binding (DISABLED)
//   live-read --client C --connection N     activation if needed, health check and one bounded sync — GET requests only;
//                                           needs the credential variable that the connection's env:// reference names
//   mapping --client C                      review queue: quarantined conflicts first, then candidates
//   onboard --client C [--mode plan|apply]  canonical people/devices from source objects (enabled M365 members and devices,
//                                           agents); confirmed links to their own objects, agent↔device hostname matches as candidates
//   confirm-link --client C --link L        reject-link --client C --link L [--reason CODE]
//   inbox --client C                        pending, retrying and dead-lettered events (eventKey, status, attempts, last code)
//   requeue --client C --event KEY          explicit, audited reprocessing of one dead letter
//   triage --client C --observation O --action acknowledge|resolve|suppress|reopen [--expected STATUS]
//   telemetry --client C [--minutes N]     decision telemetry of the last N minutes (default 60, at most 7 days)
//   m365-disable --client C --connection N  local disable of a Microsoft 365 connection (connections:manage): DISABLED and
//                                           a new lifecycleVersion, audited; no upstream call (packages/ops/m365.ts)
//   m365-probe --client C --connection N    versioned one-use activation of a bound DISABLED connection (probes, then ACTIVE);
//                                           ACTIVE → CONNECTION_ALREADY_ACTIVE without I/O (connections:manage)
//   m365-sync --client C --connection N --resource users|devices                 one directory sync attempt
//   m365-sync --client C --connection N --resource signins --from T --to T       new sign-in request + one bounded pass
//   m365-sync --client C --connection N --resource signins --request R           resume that request (no new request)
//   m365-requeue --client C --connection N --request R --window W                audited requeue of one FAILED root, no I/O
//   m365-directory-reset --client C --connection N --resource users|devices      audited directory retry reset, no I/O
//                                           (sync/requeue/reset: events:ingest + connections:manage; never sleeps)
//   m365-status --client C --connection N [--request R]   local statuses/counts/safe codes (connections:manage)
//   m365-directory --client C --connection N --resource users|devices [--limit N] [--cursor X]   approved directory DTOs
//   correlation --client C --connection N --observation O --from T --to T [--limit N] [--cursor X] CorrelationContextV1
//                                           (both reads: context:read + m365:read; ATLAS_CORRELATION_CURSOR_SECRET_REF)
//   m365-cleanup --client C                 one scoped retention pass on the EXECUTE-only runner
//                                           (ATLAS_M365_CLEANUP_RUNNER_SECRET_REF, optional ATLAS_M365_CLEANUP_TIMEOUT_MS)
//   worker-once                             one event-worker (baseline) pass over the clients the operator may ingest for
//   shadow-once                             one shadow-job pass (shadow mode only) — separate from the baseline, run it from
//                                           its own timer; both take their settings from config/decisions.json
//   decisions-smoke                         one Decisions call with a compact synthetic input; OPENAI_API_KEY, no database
//   action-preview|action-request|action-get|action-list|action-approve|action-reject|action-revoke|action-cancel|
//   action-execute|action-verify|action-recover --client C …   Stage 3 MOCK actions (packages/ops/actions.ts, RUNBOOK §9):
//                                           DISABLED unless ATLAS_ACTIONS_MODE=MOCK; built-in synthetic port only
//   poweroffice-status|poweroffice-summary|poweroffice-sync|poweroffice-recover|poweroffice-cleanup --client C --connection N
//                                           Stage 4 PowerOffice MOCK (packages/ops/poweroffice.ts, RUNBOOK §10): DISABLED unless
//                                           ATLAS_POWEROFFICE_MODE=MOCK; cleanup: ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF
// Database commands need ATLAS_RUNTIME_DATABASE_URL (the runtime role; the owner is refused) and ATLAS_OPERATOR_TOKEN, the
// API token of the actor running the command; each command needs its own permission on the client (docs/RUNBOOK.md).
// Prints one JSON object: statuses, counts, Atlas IDs and safe codes — never a token or a credential.
// Exit code: 0 done, 1 the command ran and its check failed (live-read, decisions-smoke), 2 usage, authentication or refusal.
import { hostname } from 'node:os';
import { safeErrorCode } from '../packages/core/contracts.ts';
import { assertRuntimeRole } from '../packages/graph/scoped-db.ts';
import { authenticateToken } from '../packages/auth/prisma-auth.ts';
import { loadDecisionConfig } from '../packages/decisions/config.ts';
import { createDecisionRuntime } from '../packages/decisions/runtime.ts';
import type { DecisionRuntime } from '../packages/decisions/runtime.ts';
import type { DecisionConfig } from '../packages/decisions/provider.ts';
import { OPERATOR_COMMANDS, decisionsSmoke, parseInvocation, runOperatorCommand } from '../packages/ops/commands.ts';
import type { Invocation } from '../packages/ops/commands.ts';
import { isActionCommand, runActionCli } from '../packages/ops/actions.ts';
import { isPowerOfficeCommand, runPowerOfficeCli } from '../packages/ops/poweroffice.ts';
import { fetchTransport } from '../connectors/http.ts';
import { EnvSecretResolver } from '../connectors/secrets.ts';
import { productionM365Io } from '../packages/m365/io.ts';
import type { M365Io } from '../packages/m365/io.ts';
import { openRuntimeDatabase } from '../packages/m365/maintenance.ts';
import { envCursorKey } from '../packages/correlation/cursor.ts';

const finish = (code: number, output: Record<string, unknown>): never => { console.log(JSON.stringify(output, null, 2)); process.exit(code); };
// Stage 4 PowerOffice: dedicated private-bearer dispatch before the legacy parser and its Actor authentication.
if (isPowerOfficeCommand(process.argv[2])) {
  const result = await runPowerOfficeCli(process.argv.slice(2), process.env);
  finish(result.code, result.output);
}
if (isActionCommand(process.argv[2])) {
  const result = await runActionCli(process.argv.slice(2), process.env);
  finish(result.code, result.output);
}
const invocation = ((): Invocation => {
  try { return parseInvocation(process.argv.slice(2)); }
  catch { return finish(2, { error: 'INVALID_ARGUMENTS', commands: OPERATOR_COMMANDS, help: 'see the header of scripts/ops.ts or docs/RUNBOOK.md' }); }
})();
const report = (code: number, output: Record<string, unknown>) => finish(code, { command: invocation.command, ...output });

if (invocation.command === 'decisions-smoke') {
  try {
    const result = await decisionsSmoke(loadDecisionConfig(), process.env.OPENAI_API_KEY ?? '');
    report(result.ok ? 0 : 1, result.output);
  } catch (error) { report(2, { safeErrorCode: safeErrorCode(error) }); }
}
if (!process.env.ATLAS_RUNTIME_DATABASE_URL) report(2, { error: 'ATLAS_RUNTIME_DATABASE_URL is required' });
// One pairing of the runtime URL and its Prisma client: the cleanup runner target is derived from exactly this URL.
const runtime = openRuntimeDatabase(process.env.ATLAS_RUNTIME_DATABASE_URL!);
const db = runtime.db;
let outcome: { code: number; output: Record<string, unknown> };
try {
  await assertRuntimeRole(db);
  const actor = await authenticateToken(db, process.env.ATLAS_OPERATOR_TOKEN ?? '');
  if (!actor) {
    outcome = { code: 2, output: { error: 'OPERATOR_TOKEN_INVALID' } };
  } else {
    let config: DecisionConfig | null = null; let decisions: DecisionRuntime | null = null; let m365Io: M365Io | null = null;
    const result = await runOperatorCommand({ db, actor, io: { transport: fetchTransport, secrets: new EnvSecretResolver(process.env) },
      workerId: `worker-${hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40)}-${process.pid}`,
      m365: { io: () => (m365Io ??= productionM365Io(new EnvSecretResolver(process.env))), runtime, env: process.env, cursorKey: envCursorKey(process.env) },
      config: () => (config ??= loadDecisionConfig()), runtime: () => (decisions ??= createDecisionRuntime(config ??= loadDecisionConfig())) }, invocation);
    outcome = { code: result.ok ? 0 : 1, output: result.output };
  }
} catch (error) {
  outcome = { code: 2, output: { safeErrorCode: safeErrorCode(error) } };
}
await db.$disconnect();
report(outcome.code, outcome.output);
