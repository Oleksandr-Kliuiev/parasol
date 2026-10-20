import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { hasClientPermission } from '../core/contracts.ts';
import type { DecisionRuntime } from '../decisions/runtime.ts';
import { processPending } from '../events/worker.ts';
import { processShadowJobs } from '../events/shadow.ts';

/**
 * Operator passes over every client the operator may ingest for (task 1.10, RUNBOOK). Stage 1 has no scheduler: a pass is
 * started by hand or by an external timer, and concurrent passes are safe (claims, leases and claim tokens).
 *
 * The baseline and the shadow experiment are separate passes with separate entry points (review C2): `worker-once` runs
 * the event worker only — in shadow mode it never calls the provider — and `shadow-once` runs the shadow jobs only. A slow
 * experiment of one client therefore never holds back the baseline of another; run the two from independent timers.
 */
export interface WorkerPassSummary { clientId: string; events: Record<string, number> }
export interface ShadowPassSummary { clientId: string; shadow: Record<string, number> }

const count = (outcomes: { status: string }[]) => outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
const ingestClients = (actor: Actor) => actor.memberships.map(m => m.clientId).filter(clientId => hasClientPermission(actor, clientId, 'events:ingest')).sort();
const optionsOf = (runtime: DecisionRuntime, workerId: string) => ({ workerId, provider: runtime.provider, config: runtime.config, guard: runtime.guard });

/** The event worker for each client in turn: claim, decide (rules baseline in shadow mode), commit. */
export async function runWorkerPass(db: PrismaClient, actor: Actor, runtime: DecisionRuntime, workerId: string, now?: Date): Promise<WorkerPassSummary[]> {
  const summaries: WorkerPassSummary[] = [];
  for (const clientId of ingestClients(actor)) {
    const events = await processPending(db, actor, { workspaceId: actor.workspaceId, clientId }, optionsOf(runtime, workerId), now);
    summaries.push({ clientId, events: count(events) });
  }
  return summaries;
}

/** The shadow jobs of each client in turn; outside shadow mode there is no experiment to run (an empty pass). */
export async function runShadowPass(db: PrismaClient, actor: Actor, runtime: DecisionRuntime, workerId: string): Promise<ShadowPassSummary[]> {
  if (runtime.provider.mode !== 'shadow') return [];
  const summaries: ShadowPassSummary[] = [];
  for (const clientId of ingestClients(actor)) {
    // Each client reads the clock again: jobs that became due while an earlier client's calls ran are taken in this pass
    const shadow = await processShadowJobs(db, actor, { workspaceId: actor.workspaceId, clientId }, optionsOf(runtime, workerId));
    summaries.push({ clientId, shadow: count(shadow) });
  }
  return summaries;
}
