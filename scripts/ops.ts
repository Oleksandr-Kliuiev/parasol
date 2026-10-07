// Operator CLI (docs/RUNBOOK.md):  npm run ops -- <command> [--flag value]…
//   bind --client C --connection N --system atera|huntress --tenant T --secret-ref env://NAME   explicit tenant binding (DISABLED)
//   live-read --client C --connection N     activation if needed, health check and one bounded sync — GET requests only;
//                                           needs the credential variable that the connection's env:// reference names
//   mapping --client C                      review queue: quarantined conflicts first, then candidates
//   confirm-link --client C --link L        reject-link --client C --link L [--reason CODE]
//   inbox --client C                        pending, retrying and dead-lettered events (eventKey, status, attempts, last code)
//   requeue --client C --event KEY          explicit, audited reprocessing of one dead letter
//   triage --client C --observation O --action acknowledge|resolve|suppress|reopen [--expected STATUS]
//   telemetry --client C [--minutes N]     decision telemetry of the last N minutes (default 60, at most 7 days)
//   worker-once                             one event-worker pass (and, in shadow mode, one shadow-job pass) over the clients
//                                           the operator may ingest for; settings from config/decisions.json
//   decisions-smoke                         one Decisions call with a compact synthetic input; OPENAI_API_KEY, no database
// Database commands need ATLAS_RUNTIME_DATABASE_URL (the runtime role; the owner is refused) and ATLAS_OPERATOR_TOKEN, the
// API token of the actor running the command; each command needs its own permission on the client (docs/RUNBOOK.md).
// Prints one JSON object: statuses, counts, Atlas IDs and safe codes — never a token or a credential.
// Exit code: 0 done, 1 the command ran and its check failed (live-read, decisions-smoke), 2 usage, authentication or refusal.
import { hostname } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { safeErrorCode } from '../packages/core/contracts.ts';
import { assertRuntimeRole } from '../packages/graph/scoped-db.ts';
import { authenticateToken } from '../packages/auth/prisma-auth.ts';
import { loadDecisionConfig } from '../packages/decisions/config.ts';
import { createDecisionRuntime } from '../packages/decisions/runtime.ts';
import type { DecisionRuntime } from '../packages/decisions/runtime.ts';
import type { DecisionConfig } from '../packages/decisions/provider.ts';
import { OPERATOR_COMMANDS, decisionsSmoke, parseInvocation, runOperatorCommand } from '../packages/ops/commands.ts';
import type { Invocation } from '../packages/ops/commands.ts';
import { fetchTransport } from '../connectors/http.ts';
import { EnvSecretResolver } from '../connectors/secrets.ts';

const finish = (code: number, output: Record<string, unknown>): never => { console.log(JSON.stringify(output, null, 2)); process.exit(code); };
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
const db = new PrismaClient({ datasourceUrl: process.env.ATLAS_RUNTIME_DATABASE_URL });
let outcome: { code: number; output: Record<string, unknown> };
try {
  await assertRuntimeRole(db);
  const actor = await authenticateToken(db, process.env.ATLAS_OPERATOR_TOKEN ?? '');
  if (!actor) {
    outcome = { code: 2, output: { error: 'OPERATOR_TOKEN_INVALID' } };
  } else {
    let config: DecisionConfig | null = null; let runtime: DecisionRuntime | null = null;
    const result = await runOperatorCommand({ db, actor, io: { transport: fetchTransport, secrets: new EnvSecretResolver(process.env) },
      workerId: `worker-${hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40)}-${process.pid}`,
      config: () => (config ??= loadDecisionConfig()), runtime: () => (runtime ??= createDecisionRuntime(config ??= loadDecisionConfig())) }, invocation);
    outcome = { code: result.ok ? 0 : 1, output: result.output };
  }
} catch (error) {
  outcome = { code: 2, output: { safeErrorCode: safeErrorCode(error) } };
}
await db.$disconnect();
report(outcome.code, outcome.output);
