import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PAUSE_SQL, RESERVE_SQL, SETTLE_SQL, pauseParams, reserveParams, settleParams } from '../../packages/ask/remote/ledger-sql.ts';
import type { PauseReason, SettlementOutcome, Usage } from '../../packages/ask/remote/budget.ts';

/**
 * Synthetic ASK-REMOTE R-A fixtures for disposable PostgreSQL databases. Owner-written Workspace/Client/Actor rows; every
 * policy/allowlist change goes through the trusted fence-first routines (the owner never writes the remote tables
 * directly); reserve/settle/pause run as the confined runtime role through the production statements of ledger-sql.ts.
 * Nothing here is a real admission: references are synthetic markers, no key exists and nothing is sent anywhere.
 */
export const RW = 'rem-ws'; export const RX = 'rem-ws-other';
export const RA = 'rem-client-a'; export const RB = 'rem-client-b'; export const RXC = 'rem-client-x';
export const ACTOR = 'rem-actor'; export const ACTOR_X = 'rem-actor-x';
export const PRICE = 'synthetic-price-rev-1';
export const PACKAGE_SHA256 = '9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3';
const sha = async (path: string) => createHash('sha256').update(await readFile(new URL(`../../docs/stage5/ask/remote/${path}`, import.meta.url))).digest('hex');
export const PROMPT_SHA256 = await sha('intent-prompt.json');
export const SCHEMA_SHA256 = await sha('intent-schema.json');

export async function addRemoteFixtures(owner: pg.Client): Promise<void> {
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'Remote workspace'), ($2, 'Other remote workspace')`, [RW, RX]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'A'), ($1, $3, 'B'), ($4, $5, 'X')`, [RW, RA, RB, RX, RXC]);
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor'), ($3, $4, 'Synthetic actor')`, [RW, ACTOR, RX, ACTOR_X]);
}

/** One owner transaction with app.workspace_id set (FORCE RLS applies to a non-superuser owner as well). */
export async function ownerScoped<T>(owner: pg.Client, workspace: string, fn: () => Promise<T>): Promise<T> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
    const out = await fn();
    await owner.query('COMMIT');
    return out;
  } catch (error) { await owner.query('ROLLBACK').catch(() => undefined); throw error; }
}

export interface PolicyRow {
  workspaceId: string; admissionId: string; projectIdentity: string; policyVersion: string; state: string; stateReason: string | null;
  secretRef: string; ownerApprovalRef: string; retentionAttestationRef: string; priceRevision: string; promptSha256: string; schemaSha256: string;
  packageSha256: string; dayCapMicroUsd: string; monthCapMicroUsd: string; expiresAt: string;
}
export const policyRow = (owner: pg.Client, workspace: string): Promise<PolicyRow | undefined> => ownerScoped(owner, workspace, async () =>
  (await owner.query(`SELECT "workspaceId", "admissionId"::text, "projectIdentity", "policyVersion"::text, state, "stateReason", "secretRef",
     "ownerApprovalRef", "retentionAttestationRef", "priceRevision", "promptSha256", "schemaSha256", "packageSha256", "dayCapMicroUsd"::text,
     "monthCapMicroUsd"::text, to_char("expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
     FROM "RemoteAskPolicy" WHERE "workspaceId" = $1`, [workspace])).rows[0] as PolicyRow | undefined);
export const fenceOf = (owner: pg.Client, workspace: string): Promise<number> => ownerScoped(owner, workspace, async () =>
  (await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [workspace])).rows[0].version as number);

export interface CreateOptions { admissionId?: string; project?: string; dayCap?: string; monthCap?: string; expiresInMs?: number }
/** Trusted creation (INACTIVE, version 1). Returns the admission ID and project. */
export async function createPolicy(owner: pg.Client, workspace: string, o: CreateOptions = {}): Promise<{ admissionId: string; project: string }> {
  const admissionId = o.admissionId ?? randomUUID(); const project = o.project ?? `synthetic-project-${workspace}`;
  await ownerScoped(owner, workspace, () => owner.query(`SELECT public.atlas_ask_remote_policy_create($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint,
      $12::bigint, $13::timestamptz)`, [workspace, admissionId, project, 'fixture://ask-remote/synthetic-key-ref', 'synthetic-owner-approval',
    'synthetic-retention-attestation', PRICE, PROMPT_SHA256, SCHEMA_SHA256, PACKAGE_SHA256, o.dayCap ?? '2000000', o.monthCap ?? '10000000',
    new Date(Date.now() + (o.expiresInMs ?? 24 * 3_600_000)).toISOString()]));
  return { admissionId, project };
}
export interface RevisionFields {
  state: string; secretRef: string; ownerApprovalRef: string; retentionAttestationRef: string; priceRevision: string; promptSha256: string;
  schemaSha256: string; packageSha256: string; dayCapMicroUsd: string; monthCapMicroUsd: string; expiresAt: string;
}
/** Trusted revision stating every material field (current values unless changed). Returns the resulting policyVersion. */
export async function revise(owner: pg.Client, workspace: string, changes: Partial<RevisionFields> = {}, expected?: string): Promise<string> {
  const cur = (await policyRow(owner, workspace))!;
  const f = { ...cur, ...changes };
  return ownerScoped(owner, workspace, async () => (await owner.query(`SELECT public.atlas_ask_remote_policy_revise($1, $2::uuid, $3::bigint, $4, $5, $6, $7, $8,
      $9, $10, $11, $12::bigint, $13::bigint, $14::timestamptz)::text AS v`, [workspace, cur.admissionId, expected ?? cur.policyVersion, f.state, f.secretRef,
    f.ownerApprovalRef, f.retentionAttestationRef, f.priceRevision, f.promptSha256, f.schemaSha256, f.packageSha256, f.dayCapMicroUsd, f.monthCapMicroUsd,
    f.expiresAt])).rows[0].v as string);
}
export async function setClient(owner: pg.Client, workspace: string, client: string, admitted: boolean, expected?: string): Promise<string> {
  const cur = (await policyRow(owner, workspace))!;
  return ownerScoped(owner, workspace, async () => (await owner.query(`SELECT public.atlas_ask_remote_client_set($1, $2::uuid, $3, $4::bigint, $5)::text AS v`,
    [workspace, cur.admissionId, client, expected ?? cur.policyVersion, admitted])).rows[0].v as string);
}
/** Synthetic disposable-DB activation through the trusted routines only: create → admit client(s) → ACTIVE. */
export async function activate(owner: pg.Client, workspace: string, clients: string[], o: CreateOptions = {}):
  Promise<{ admissionId: string; project: string; policyVersion: string }> {
  const created = await createPolicy(owner, workspace, o);
  for (const c of clients) await setClient(owner, workspace, c, true);
  const policyVersion = await revise(owner, workspace, { state: 'ACTIVE' });
  return { ...created, policyVersion };
}

export interface FreshProject { ws: string; client: string; actor: string; admissionId: string; policyVersion: string; project: string }
let fresh = 0;
/** An independently provisioned synthetic workspace/client/actor with its own ACTIVE policy (trusted routines only). */
export async function freshProject(owner: pg.Client, label: string, o: CreateOptions = {}): Promise<FreshProject> {
  const n = ++fresh; const ws = `rem-${label}-${n}`; const client = `rem-${label}-client-${n}`; const actor = `rem-${label}-actor-${n}`;
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'Synthetic remote workspace')`, [ws]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'C')`, [ws, client]);
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor')`, [ws, actor]);
  return { ws, client, actor, ...await activate(owner, ws, [client], o) };
}

export interface Ledger { counters: { kind: string; periodStart: string; charged: string }[]; attempts: Record<string, string | null>[] }
export const ledger = (owner: pg.Client, workspace: string): Promise<Ledger> => ownerScoped(owner, workspace, async () => ({
  counters: (await owner.query(`SELECT kind, "periodStart"::text AS "periodStart", "chargedMicroUsd"::text AS charged FROM "RemoteAskPeriodCounter"
     WHERE "workspaceId" = $1 ORDER BY kind, "periodStart"`, [workspace])).rows,
  attempts: (await owner.query(`SELECT id::text, "clientId", state, outcome, "accountedMicroUsd"::text AS accounted, "policyVersion"::text AS "policyVersion",
     "dayStart"::text AS "dayStart", "monthStart"::text AS "monthStart", "promptTokens"::text AS "promptTokens", "completionTokens"::text AS "completionTokens"
     FROM "RemoteAskAttempt" WHERE "workspaceId" = $1 ORDER BY "createdAt", id`, [workspace])).rows,
}));

export async function connectAs(url: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }
async function runtimeTx<T>(runtime: pg.Client, workspace: string, client: string, fn: () => Promise<T>): Promise<T> {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [workspace, client]);
    const out = await fn();
    await runtime.query('COMMIT');
    return out;
  } catch (error) { await runtime.query('ROLLBACK').catch(() => undefined); throw error; }
}
export interface ReserveOptions { fenceVersion?: number; correlationId?: string; priceRevision?: string; actor?: string; scopeWorkspace?: string; scopeClient?: string }
/** One egress-admission transaction as R-B will run it: scope → fence FOR SHARE (captured epoch) → reserve routine → COMMIT. */
export async function reserveOnce(runtime: pg.Client, workspace: string, client: string, consent: { admissionId: string; policyVersion: string },
  o: ReserveOptions = {}): Promise<{ attemptId: string; correlationId: string }> {
  const correlationId = o.correlationId ?? randomUUID();
  const attemptId = await runtimeTx(runtime, o.scopeWorkspace ?? workspace, o.scopeClient ?? client, async () => {
    const fence = (await runtime.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [workspace])).rows[0]?.version as number | undefined;
    return (await runtime.query(RESERVE_SQL, reserveParams({ workspaceId: workspace, clientId: client, actorId: o.actor ?? ACTOR, admissionId: consent.admissionId,
      policyVersion: consent.policyVersion, fenceVersion: o.fenceVersion ?? fence ?? 0, priceRevision: o.priceRevision ?? PRICE, correlationId }))).rows[0].attemptId as string;
  });
  return { attemptId, correlationId };
}
export const settleOnce = (runtime: pg.Client, workspace: string, client: string, attempt: { attemptId: string; correlationId: string },
  outcome: SettlementOutcome, usage: Usage | null = null): Promise<string> => runtimeTx(runtime, workspace, client, async () =>
  (await runtime.query(SETTLE_SQL, settleParams({ workspaceId: workspace, clientId: client, attemptId: attempt.attemptId, correlationId: attempt.correlationId,
    outcome, usage }))).rows[0].accountedMicroUsd as string);
export const pauseOnce = (runtime: pg.Client, workspace: string, admissionId: string, reason: PauseReason = 'MODEL_MISMATCH'): Promise<string> =>
  runtimeTx(runtime, workspace, '', async () => (await runtime.query(PAUSE_SQL, pauseParams({ workspaceId: workspace, admissionId, reason }))).rows[0].policyVersion as string);

/** The SQLSTATE of an expected failure (fails the test when it resolves). */
export async function sqlstate(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (error) { return String((error as { code?: unknown }).code ?? 'NO_CODE'); }
  throw new Error('expected a database error');
}
