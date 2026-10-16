import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { assertPermission } from '../core/contracts.ts';
import { withScope } from '../graph/scoped-db.ts';

/**
 * Decision telemetry of one client over a time window (task 1.7, docs/04 metrics), computed from the durable records in one
 * scoped read: every provider call is a DecisionRun (status, safe code — MODEL_MISMATCH included — models, latency, input
 * tokens, config version), every shadow experiment a ShadowJob, every routed event an Observation. Nothing here is a label
 * or an accuracy claim: shadow agreement compares the AI route with the applied rules baseline, not with the truth.
 */
export interface DecisionTelemetry {
  window: { since: string; until: string };
  /** All DecisionRuns by provider, mode, status and failure code (rules runs included: they are the applied baselines). */
  runs: { provider: string; mode: string; status: string; code: string | null; count: number }[];
  /** Provider calls only: latency percentiles and how many kept the deadline. */
  latency: { provider: string; calls: number; p50Ms: number | null; p95Ms: number | null; withinDeadline: number }[];
  inputTokens: { provider: string; callsWithUsage: number; total: number; perCall: number | null; perEvent: number | null }[];
  /** Applied baseline route × shadow AI route for the same event (OK shadow runs). */
  shadowAgreement: { baseline: string; shadow: string; count: number }[];
  shadowJobs: { status: string; code: string | null; count: number }[];
  /** Events the guard switched to the rules mode (circuit open, call budget spent). */
  guardRefusals: { reason: string; count: number }[];
  review: { observations: number; humanReview: number; rate: number | null };
}

const num = (value: unknown): number => Number(value);
const rate = (part: number, whole: number): number | null => whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

export async function decisionTelemetry(db: PrismaClient, actor: Actor, scope: Scope,
  window: { since: Date; until?: Date; deadlineMs: number }): Promise<DecisionTelemetry> {
  assertPermission(actor, scope, 'context:read');
  const until = window.until ?? new Date();
  const ws = scope.workspaceId; const c = scope.clientId; const since = window.since;
  return withScope(db, actor, [scope.clientId], async tx => {
    const runs = await tx.$queryRaw<{ provider: string; mode: string; status: string; code: string | null; count: number }[]>`
      SELECT provider, mode, status, "safeErrorCode" AS code, count(*)::int AS count FROM "DecisionRun"
      WHERE "workspaceId" = ${ws} AND "clientId" = ${c} AND "createdAt" >= ${since} AND "createdAt" < ${until}
      GROUP BY provider, mode, status, "safeErrorCode" ORDER BY provider, mode, status, "safeErrorCode" NULLS FIRST`;
    const latency = await tx.$queryRaw<{ provider: string; calls: number; p50: number | null; p95: number | null; within: number }[]>`
      SELECT provider, count(*)::int AS calls, percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95, count(*) FILTER (WHERE "latencyMs" <= ${window.deadlineMs})::int AS within
      FROM "DecisionRun" WHERE "workspaceId" = ${ws} AND "clientId" = ${c} AND "createdAt" >= ${since} AND "createdAt" < ${until}
        AND provider <> 'rules' AND "latencyMs" IS NOT NULL
      GROUP BY provider ORDER BY provider`;
    const tokens = await tx.$queryRaw<{ provider: string; withUsage: number; total: bigint; events: number }[]>`
      SELECT provider, count("inputTokens")::int AS "withUsage", coalesce(sum("inputTokens"), 0)::bigint AS total,
        count(DISTINCT "eventId") FILTER (WHERE "inputTokens" IS NOT NULL)::int AS events
      FROM "DecisionRun" WHERE "workspaceId" = ${ws} AND "clientId" = ${c} AND "createdAt" >= ${since} AND "createdAt" < ${until} AND provider <> 'rules'
      GROUP BY provider ORDER BY provider`;
    const agreement = await tx.$queryRaw<{ baseline: string; shadow: string; count: number }[]>`
      SELECT a.result->>'route' AS baseline, s.result->>'route' AS shadow, count(*)::int AS count
      FROM "DecisionRun" s JOIN "DecisionRun" a ON a."workspaceId" = s."workspaceId" AND a."clientId" = s."clientId" AND a."eventId" = s."eventId" AND a.applied
      WHERE s."workspaceId" = ${ws} AND s."clientId" = ${c} AND s.mode = 'shadow' AND NOT s.applied AND s.status = 'OK'
        AND s."createdAt" >= ${since} AND s."createdAt" < ${until}
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const jobs = await tx.$queryRaw<{ status: string; code: string | null; count: number }[]>`
      SELECT status, "lastErrorCode" AS code, count(*)::int AS count FROM "ShadowJob"
      WHERE "workspaceId" = ${ws} AND "clientId" = ${c} AND "createdAt" >= ${since} AND "createdAt" < ${until}
      GROUP BY 1, 2 ORDER BY 1, 2 NULLS FIRST`;
    const refusals = await tx.$queryRaw<{ reason: string; count: number }[]>`
      SELECT reason, count(*)::int AS count FROM "Observation" o, unnest(o."reasonCodes") AS reason
      WHERE o."workspaceId" = ${ws} AND o."clientId" = ${c} AND o."createdAt" >= ${since} AND o."createdAt" < ${until}
        AND reason IN ('PROVIDER_CIRCUIT_OPEN', 'PROVIDER_BUDGET_EXHAUSTED')
      GROUP BY reason ORDER BY reason`;
    const [review] = await tx.$queryRaw<{ observations: number; review: number }[]>`
      SELECT count(*)::int AS observations, count(*) FILTER (WHERE route = 'HUMAN_REVIEW')::int AS review FROM "Observation"
      WHERE "workspaceId" = ${ws} AND "clientId" = ${c} AND "createdAt" >= ${since} AND "createdAt" < ${until}`;
    return {
      window: { since: since.toISOString(), until: until.toISOString() },
      runs: runs.map(r => ({ ...r, count: num(r.count) })),
      latency: latency.map(l => ({ provider: l.provider, calls: num(l.calls), p50Ms: l.p50 === null ? null : Math.round(num(l.p50)),
        p95Ms: l.p95 === null ? null : Math.round(num(l.p95)), withinDeadline: num(l.within) })),
      inputTokens: tokens.map(t => ({ provider: t.provider, callsWithUsage: num(t.withUsage), total: num(t.total),
        perCall: t.withUsage ? Math.round(num(t.total) / num(t.withUsage)) : null, perEvent: t.events ? Math.round(num(t.total) / num(t.events)) : null })),
      shadowAgreement: agreement.map(a => ({ ...a, count: num(a.count) })),
      shadowJobs: jobs.map(j => ({ ...j, count: num(j.count) })),
      guardRefusals: refusals.map(r => ({ ...r, count: num(r.count) })),
      review: { observations: num(review?.observations ?? 0), humanReview: num(review?.review ?? 0), rate: rate(num(review?.review ?? 0), num(review?.observations ?? 0)) },
    };
  });
}
