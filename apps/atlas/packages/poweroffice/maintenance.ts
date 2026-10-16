import { PrismaClient } from '@prisma/client';
import { runnerUrlFor } from '../m365/maintenance.ts';
import { powerOfficeError } from './contracts.ts';
import { withPowerOfficeAuthority } from './authority.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { checkBinding } from './binding.ts';
import { compositionPort } from './composition.ts';
import { POWEROFFICE_PAIRING_SQL, POWEROFFICE_RUNNER_CHECK_SQL, runnerProblems } from './runner-role.ts';
import type { Pairing, RunnerFacts } from './runner-role.ts';
import { runBoundedTransaction, startBudget } from './runner-transaction.ts';

/**
 * Explicit bounded PowerOffice cleanup, `poweroffice-cleanup` (docs/stage4/03_DATA_AND_CONCURRENCY.md "Explicit bounded
 * maintenance", 01 "Freshness and retention").
 *
 * 1. Fresh maintain ADMISSION on the paired runtime database (authority.ts, operation maintain): bearer → workspace fence
 *    FOR UPDATE → readiness → current all-of context:read + poweroffice:read + poweroffice:maintain on ONE membership
 *    (otherwise one workspace denial) → plain scoped Connection read → token/actor/rights again after the locks. The
 *    connection must be a PowerOffice connection in the immutable synthetic binding; DISABLED or an advanced lifecycle is
 *    allowed (closeout: purge only, no reactivation, no source). Under the same fence it records the pairing facts. The
 *    result is an opaque single-use capability (module-private WeakMap): a caller cannot forge its database, scope or actor.
 *    As accepted for Stage 2, an admitted cleanup may complete after a later revocation; it confers no read/source authority.
 * 2. Configuration: ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF=env://NAME names the runner URL. Its complete target
 *    (protocol, host, effective port, path, every query option) must equal the paired runtime URL's; the URL actually used
 *    is the RUNTIME URL with only the runner credentials substituted (m365/maintenance.ts runnerUrlFor). URLs are never
 *    printed or returned; a misconfiguration is POWEROFFICE_RUNTIME_NOT_READY.
 * 3. ONE runner transaction on ONE explicit runner connection under ONE original monotonic 10 s budget
 *    (runner-transaction.ts) that starts before the connection exists and is never reset; it bounds acquisition, setup,
 *    locks, the routine AND COMMIT with actual server-side cancellation (a PostgreSQL 17 transaction_timeout set and
 *    verified as a session setting BEFORE BEGIN, so BEGIN arms exactly it regardless of inherited role/database/startup
 *    values), plus lock_timeout 1000 ms and statement_timeout ≤ remaining before every statement. Inside it: runner confinement +
 *    same-database pairing facts (runner-role.ts), the singleton GUCs from the admitted capability, then
 *    public.atlas_poweroffice_cleanup(workspace, client, connection, correlation). Any timeout rolls everything back:
 *    POWEROFFICE_CLEANUP_TIMEOUT. A deadlock/serialization abort is POWEROFFICE_DB_CONFLICT; an ACTIVE claim (even expired)
 *    POWEROFFICE_SYNC_BUSY with zero effects (recover first); runner initialization/confinement/pairing failures
 *    POWEROFFICE_RUNTIME_NOT_READY; any other failure (PO010 scope/binding refusal, audit failure, …)
 *    POWEROFFICE_CLEANUP_FAILED. No automatic loop or retry. A missing State is a no-op.
 *    Counts return to the trusted CLI only (never audit, never amounts); the routine's own audit has the six-key shape.
 */
export const CLEANUP_RUNNER_REF_VARIABLE = 'ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF';
export { CLEANUP_BUDGET_MS, CLEANUP_LOCK_TIMEOUT_MS } from './runner-transaction.ts';
type Env = Readonly<Record<string, string | undefined>>;

/** The runtime Prisma client paired privately with the URL it was built from (only this factory pairs them). */
export interface PowerOfficeRuntime { readonly db: PrismaClient }
const runtimeUrls = new WeakMap<PowerOfficeRuntime, string>();
export function openPowerOfficeRuntime(url: string): PowerOfficeRuntime {
  const runtime: PowerOfficeRuntime = Object.freeze({ db: new PrismaClient({ datasourceUrl: url }) });
  runtimeUrls.set(runtime, url);
  return runtime;
}

export interface CleanupAdmission { readonly kind: 'PowerOfficeCleanupAdmission' }
interface Admitted {
  runtime: PowerOfficeRuntime; workspaceId: string; clientId: string; connectionId: string; actorId: string; correlationId: string;
  pairing: Pairing; used: boolean;
}
const admissions = new WeakMap<CleanupAdmission, Admitted>();

/** Step 1: fresh maintain admission under the runtime fence; returns the private single-use capability. */
export async function admitPowerOfficeCleanup(runtime: PowerOfficeRuntime, composition: unknown, credential: PowerOfficeCredential, clientId: string,
  connectionId: string): Promise<CleanupAdmission> {
  compositionPort(composition); // mode first; cleanup never uses the port
  if (!runtimeUrls.has(runtime)) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
  if (typeof clientId !== 'string' || typeof connectionId !== 'string') throw powerOfficeError('INVALID_ARGUMENTS');
  const admitted = await withPowerOfficeAuthority<null, Omit<Admitted, 'runtime' | 'used'>>(runtime.db, credential, { clientId, connectionId, operation: 'maintain' }, {
    async lock() { return null; }, // fence only: the routine itself takes fence → Connection → State under the runner
    async run(tx, authority) {
      const binding = checkBinding(authority.connection, 'closeout');
      if ('refused' in binding) return { refused: binding.refused };
      const rows = await tx.$queryRawUnsafe<Pairing[]>(POWEROFFICE_PAIRING_SQL);
      if (rows.length !== 1 || typeof rows[0]!.runner !== 'string') return { refused: 'POWEROFFICE_RUNTIME_NOT_READY' };
      return { ok: { workspaceId: authority.workspaceId, clientId: authority.clientId, connectionId: authority.connectionId, actorId: authority.actorId,
        correlationId: authority.correlationId, pairing: Object.freeze({ ...rows[0]! }) } };
    },
  });
  const capability: CleanupAdmission = Object.freeze({ kind: 'PowerOfficeCleanupAdmission' as const });
  admissions.set(capability, { ...admitted, runtime, used: false });
  return capability;
}

export interface PowerOfficeCleanupReceipt {
  readonly connectionId: string; readonly outcome: 'COMPLETED' | 'NO_STATE'; readonly clearedPointer: boolean; readonly deletedSnapshots: number;
  readonly deletedAttempts: number; readonly morePending: boolean; readonly synthetic: true;
}
/** The runner URL for a paired runtime: the configured reference must name a same-target URL; otherwise RUNTIME_NOT_READY. */
export function powerOfficeRunnerUrl(runtime: PowerOfficeRuntime, env: Env): string {
  const runtimeUrl = runtimeUrls.get(runtime);
  const name = /^env:\/\/([A-Z][A-Z0-9_]{0,99})$/.exec(env[CLEANUP_RUNNER_REF_VARIABLE] ?? '')?.[1];
  const value = name ? env[name] : undefined;
  if (!runtimeUrl || !value) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
  try { return runnerUrlFor(runtimeUrl, value); } catch { throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY'); }
}

/** Steps 2–3: one bounded runner transaction for the admitted connection (runner-transaction.ts). Consumes the capability. */
export async function runPowerOfficeCleanup(admission: CleanupAdmission, env: Env): Promise<PowerOfficeCleanupReceipt> {
  const admitted = admissions.get(admission);
  if (admitted === undefined || admitted.used) throw powerOfficeError('POWEROFFICE_CLEANUP_FAILED');
  admitted.used = true;
  const runnerUrl = powerOfficeRunnerUrl(admitted.runtime, env);
  const budget = startBudget(); // the ONE original budget: acquisition, BEGIN, anchor, setup, locks, routine, COMMIT
  const result = await runBoundedTransaction(runnerUrl, budget, async (query, bounded) => {
    await bounded.statement();
    const facts = (await query<RunnerFacts>(POWEROFFICE_RUNNER_CHECK_SQL))[0];
    if (runnerProblems(facts, admitted.pairing).length > 0) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
    await bounded.statement();
    await query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.actor_id', $3, true),
      set_config('app.poweroffice_connection_id', $4, true)`, admitted.workspaceId, admitted.clientId, admitted.actorId, admitted.connectionId);
    await bounded.statement();
    const rows = await query<{ r: Record<string, unknown> }>(`SELECT public.atlas_poweroffice_cleanup($1, $2, $3, $4::uuid) AS r`,
      admitted.workspaceId, admitted.clientId, admitted.connectionId, admitted.correlationId);
    return rows[0]?.r ?? null;
  });
  if (result?.outcome === 'BUSY') throw powerOfficeError('POWEROFFICE_SYNC_BUSY');
  if ((result?.outcome !== 'COMPLETED' && result?.outcome !== 'NO_STATE') || typeof result.clearedPointer !== 'boolean'
    || typeof result.morePending !== 'boolean' || !Number.isSafeInteger(result.deletedSnapshots) || !Number.isSafeInteger(result.deletedAttempts)) {
    throw powerOfficeError('POWEROFFICE_CLEANUP_FAILED');
  }
  return Object.freeze({ connectionId: admitted.connectionId, outcome: result.outcome, clearedPointer: result.clearedPointer,
    deletedSnapshots: result.deletedSnapshots as number, deletedAttempts: result.deletedAttempts as number, morePending: result.morePending, synthetic: true as const });
}
