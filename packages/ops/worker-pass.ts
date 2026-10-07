import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { hasClientPermission } from '../core/contracts.ts';
import type { DecisionRuntime } from '../decisions/runtime.ts';
import { processPending } from '../events/worker.ts';
import { processShadowJobs } from '../events/shadow.ts';

/**
 * One pass of the event worker — and, in shadow mode, of the shadow runner — over every client the operator may ingest for
 * (task 1.10, RUNBOOK). Stage 1 has no scheduler: a pass is started by hand or by an external timer, and it is safe to run
 * concurrently (claims, leases and tokens). The summary counts outcomes by status per client.
 */
export interface WorkerPassSummary { clientId: string; events: Record<string, number>; shadow: Record<string, number> }

const count = (outcomes: { status: string }[]) => outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});

export async function runWorkerPass(db: PrismaClient, actor: Actor, runtime: DecisionRuntime, workerId: string, now: Date = new Date()): Promise<WorkerPassSummary[]> {
  const clients = actor.memberships.map(m => m.clientId).filter(clientId => hasClientPermission(actor, clientId, 'events:ingest')).sort();
  const summaries: WorkerPassSummary[] = [];
  for (const clientId of clients) {
    const scope = { workspaceId: actor.workspaceId, clientId };
    const options = { workerId, provider: runtime.provider, config: runtime.config, guard: runtime.guard };
    const events = await processPending(db, actor, scope, options, now);
    // Jobs created by this event pass become due at their own commit time, so the shadow pass reads the clock again
    const shadow = runtime.provider.mode === 'shadow' ? await processShadowJobs(db, actor, scope, options) : [];
    summaries.push({ clientId, events: count(events), shadow: count(shadow) });
  }
  return summaries;
}
