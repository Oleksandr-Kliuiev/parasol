import type { PrismaClient } from '@prisma/client';
import { currentToken, setLocal } from '../auth/transaction-token.ts';
import { askFailure } from '../ask/contracts.ts';
import { clearSettings, currentActor, phaseTx } from '../ask/db-phase.ts';
import type { PhaseRun, PhaseSql } from '../ask/phase.ts';
import type { EvaluationPhases } from '../ask/remote/evaluation.ts';
import type { Scope } from '../ask/source.ts';
import type { FailureCode } from './codes.ts';
import { DATASET_MANIFEST_SHA256 } from './dataset.ts';
import { syntheticSourceReference } from './source-clock.ts';

/**
 * Bridge-server DB reads of the registered sandbox (rs-c/IMPLEMENTATION_BRIEF.md §2–§4), all under the confined runtime role
 * with its RS-B column SELECTs and the accepted bounded phase runner. Read-only: no audit, no write, no financial lock. The
 * registration is derived from the measured launch (workspace + registration/instance IDs), never from a header.
 */
export interface RegisteredScope {
  readonly registrationId: string; readonly databaseInstanceId: string; readonly workspaceId: string; readonly clientId: string; readonly actorId: string;
  readonly admissionId: string;
}
export interface CurrentFacts {
  readonly fixtureId: string; readonly fixtureGeneration: string; readonly syntheticFreshnessAt: string; readonly datasetManifestSha256: string;
  readonly policyState: string | null; readonly policyVersion: string | null; readonly policyAdmissionId: string | null; readonly policyExpiresMs: number | null;
}
const RUN: PhaseRun = Object.freeze({ check() { /* evaluation bookkeeping reads: their own bounded clock */ } });
const held = new Set<Promise<unknown>>();
const hold = (w: Promise<unknown>) => { held.add(w); void w.finally(() => held.delete(w)); };
const tx = <T>(db: PrismaClient, ms: number, fn: (sql: PhaseSql) => Promise<T>) => phaseTx(db, RUN, ms, hold, fn, () => new Error('REVAL_EVAL_DB'));
const q = <T>(sql: PhaseSql, text: string, ...params: unknown[]) => sql(t => t.$queryRawUnsafe<T[]>(text, ...params));

export const BINDING_SQL = `SELECT b."fixtureId" AS f, b.generation::text AS g, b."datasetManifestSha256" AS ds,
  pg_catalog.to_char(b."syntheticFreshnessAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ref
  FROM public."RevalFixtureBinding" b WHERE b."registrationId" = $1::uuid AND b."workspaceId" = $2 AND b."clientId" = $3`;
interface BindingRow { f: string; g: string; ds: string; ref: string }

/** The registration row of the measured launch; every immutable column must match the launch frame. */
export async function readRegistration(db: PrismaClient, workspaceId: string, registrationId: string, databaseInstanceId: string): Promise<RegisteredScope> {
  return tx(db, 2000, async sql => {
    await clearSettings(sql);
    await sql(t => setLocal(t, { 'app.workspace_id': workspaceId }));
    const rows = await q<{ dbi: string; cl: string; ac: string; adm: string; ds: string; syn: boolean }>(sql, `SELECT r."databaseInstanceId"::text AS dbi,
      r."clientId" AS cl, r."actorId" AS ac, r."admissionId"::text AS adm, r."datasetManifestSha256" AS ds, r."syntheticOnly" AS syn
      FROM public."RevalSandboxRegistration" r WHERE r."registrationId" = $1::uuid AND r."workspaceId" = $2`, registrationId, workspaceId);
    const r = rows[0];
    if (rows.length !== 1 || !r || r.dbi !== databaseInstanceId || r.ds !== DATASET_MANIFEST_SHA256 || r.syn !== true) throw new Error('REVAL_REGISTRATION_MISMATCH');
    return Object.freeze({ registrationId, databaseInstanceId, workspaceId, clientId: r.cl, actorId: r.ac, admissionId: r.adm });
  });
}
/** Binding and policy facts at one READ COMMITTED instant (arm checks, PAIR200 focus/expiry, RESPONSE recheck), bounded by `ms`. */
export async function currentFacts(db: PrismaClient, reg: RegisteredScope, ms = 2000): Promise<CurrentFacts> {
  return tx(db, Math.max(1, Math.floor(ms)), async sql => {
    await clearSettings(sql);
    await sql(t => setLocal(t, { 'app.workspace_id': reg.workspaceId, 'app.client_ids': reg.clientId }));
    const b = (await q<BindingRow>(sql, BINDING_SQL, reg.registrationId, reg.workspaceId, reg.clientId))[0];
    if (!b) throw new Error('REVAL_BINDING_MISSING');
    const p = (await q<{ a: string; v: string; s: string; e: string }>(sql, `SELECT "admissionId"::text AS a, "policyVersion"::text AS v, state AS s,
      (extract(epoch FROM "expiresAt") * 1000)::bigint::text AS e FROM public."RemoteAskPolicy" WHERE "workspaceId" = $1`, reg.workspaceId))[0];
    return Object.freeze({ fixtureId: b.f, fixtureGeneration: b.g, syntheticFreshnessAt: b.ref, datasetManifestSha256: b.ds, policyState: p?.s ?? null,
      policyVersion: p?.v ?? null, policyAdmissionId: p?.a ?? null, policyExpiresMs: p ? Number(p.e) : null });
  });
}
/**
 * Current authority of a handoff caller (04 PAIR/RESPONSE): the bearer digest is a current token of EXACTLY the registered
 * workspace and actor, the actor is ACTIVE and holds ONE membership of the registered client with context:read AND ask:remote,
 * under the workspace fence FOR SHARE. Read-only (no denial audit: the handoff route is not an Ask request).
 */
export type HandoffAuthority = { readonly code: FailureCode } | { readonly code: null; readonly credentialExpiresMs: number | null };
export async function handoffAuthority(db: PrismaClient, reg: RegisteredScope, hash: string, ms = 2000): Promise<HandoffAuthority> {
  const denied = (code: FailureCode): HandoffAuthority => ({ code });
  try {
    return await tx(db, Math.max(1, Math.floor(ms)), async sql => {
      await clearSettings(sql);
      const token = await sql(t => currentToken(t, hash));
      if (!token) return denied('UNAUTHORIZED');
      if (token.workspaceId !== reg.workspaceId || token.actorId !== reg.actorId) return denied('SCOPE_MISMATCH');
      await sql(t => setLocal(t, { 'app.workspace_id': reg.workspaceId }));
      const fence = await q<{ v: string }>(sql, `SELECT version::text AS v FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, reg.workspaceId);
      if (fence.length !== 1) return denied('INTERNAL_FAILURE');
      const actor = await currentActor(sql, reg.workspaceId, reg.actorId, true);
      if (!actor) return denied('UNAUTHORIZED');
      const member = actor.memberships.filter(m => m.clientId === reg.clientId);
      if (member.length !== 1 || !['context:read', 'ask:remote'].every(p => member[0]!.permissions.includes(p))) return denied('SCOPE_MISMATCH');
      return { code: null, credentialExpiresMs: token.expiresAt ? token.expiresAt.getTime() : null };
    });
  } catch { return denied('INTERNAL_FAILURE'); }
}
/**
 * The registered task's phase hooks: phase1 reads the binding inside the fenced scoped transaction, requires the arm's
 * generation and the frozen dataset, and returns the pinned source-only reference; egress/phase2 re-read the generation.
 */
export function evaluationPhases(reg: RegisteredScope, expectedGeneration: string): EvaluationPhases {
  const binding = async (sql: PhaseSql, scope: Scope): Promise<BindingRow> => {
    if (scope.workspaceId !== reg.workspaceId || scope.clientId !== reg.clientId) askFailure('ASK_SCOPE_DENIED');
    const b = (await q<BindingRow>(sql, BINDING_SQL, reg.registrationId, reg.workspaceId, reg.clientId))[0];
    if (!b || b.g !== expectedGeneration || b.ds !== DATASET_MANIFEST_SHA256) askFailure('ASK_SCOPE_CHANGED');
    return b;
  };
  return Object.freeze({
    async phase1(sql, scope) {
      const b = await binding(sql, scope);
      try { return syntheticSourceReference({ fixtureId: b.f, generation: b.g, syntheticFreshnessAt: b.ref, datasetManifestSha256: b.ds }); }
      catch { return askFailure('ASK_SCOPE_CHANGED'); }
    },
    async recheck(sql, scope) { await binding(sql, scope); },
  } satisfies EvaluationPhases);
}
