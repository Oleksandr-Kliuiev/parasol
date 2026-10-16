import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadFrozenDataset } from '../../packages/reval/dataset.ts';
import type { FrozenDataset } from '../../packages/reval/dataset.ts';
import { preservedFingerprint, scopedKeys, setScope } from '../../packages/reval/inventory.ts';
import type { RegisteredRoles } from '../../packages/reval/inventory.ts';
import { installFixture } from '../../packages/reval/materialize.ts';
import type { InstallResult, Registration, SwitchHooks } from '../../packages/reval/materialize.ts';
import type { QueryClient } from '../../packages/reval/physical.ts';
import { UTC_TYPES } from '../../packages/reval/pg-tx.ts';
import { loadSeedMapping } from '../../packages/reval/seed-plan.ts';
import { createPolicy, revise, setClient } from './ask-remote-pg.ts';

/**
 * Synthetic R-EVAL RS-B sandbox for disposable PostgreSQL 17 databases (test-only). The frozen fixture scope
 * (`syn-ws-reval` / `syn-client-reval`), one designated actor with context:read + ask:remote, a policy created INACTIVE,
 * the client admitted and the policy revised to PAUSED (rc2: maintenance requires PAUSED) — trusted routines only. The table owner writes nothing else; the maintenance code under test
 * does the rest.
 */
export const WS = 'syn-ws-reval'; export const CLIENT = 'syn-client-reval'; export const ACTOR = 'syn-actor-reval';
export const BUILD = 'c'.repeat(64);
export const dataset: FrozenDataset = loadFrozenDataset();
export const mapping = loadSeedMapping();
export const q = (c: pg.Client) => c as unknown as QueryClient;
export const pidOf = async (c: pg.Client): Promise<string> => String((await c.query('SELECT pg_backend_pid() AS p')).rows[0].p);
export const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; message?: string }) => e.code ?? e.message ?? String(e));

export async function provisionSandbox(owner: pg.Client, permissions = ['context:read', 'ask:remote']): Promise<{ admissionId: string }> {
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'R-EVAL synthetic sandbox')`, [WS]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'Synthetic client')`, [WS, CLIENT]);
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Designated operator')`, [WS, ACTOR]);
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId", "clientId", "actorId", permissions) VALUES ($1, $2, $3, $4)`, [WS, CLIENT, ACTOR, permissions]);
  const { admissionId } = await createPolicy(owner, WS);
  await setClient(owner, WS, CLIENT, true);
  await revise(owner, WS, { state: 'PAUSED' });
  return { admissionId };
}
export const registration = (admissionId: string, readerRole: string, build = BUILD): Registration => ({ registrationId: randomUUID(),
  databaseInstanceId: randomUUID(), workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, evidenceReaderRole: readerRole, buildManifestSha256: build });
/** RS-D-A: role names no session can have — the RS-B semantics (every other backend refuses) unless a test names the registered roles. */
export const NO_REGISTERED_ROLES = Object.freeze({ runtime: '', reader: '' });
export const install = (owner: pg.Client, r: Registration, id: string, gen: string, pids: string[], hooks?: SwitchHooks, ds: FrozenDataset = dataset,
  roles: RegisteredRoles = NO_REGISTERED_ROLES): Promise<InstallResult> => installFixture(q(owner), r, ds, mapping, id, gen, pids, roles, hooks);
/** A runtime-role client decoding timestamps as UTC (as the production verifier does). */
export async function runtimeClient(url: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: url, types: UTC_TYPES }); await c.connect(); return c; }
/** Binding generation/fixture, scoped keys and the preserved fingerprint, read by the owner in one scoped read-only transaction. */
export async function state(owner: pg.Client, r: Registration): Promise<{ gen: string | null; fixture: string | null; keys: string; preserved: string; fence: string }> {
  await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await setScope(q(owner), r);
    const b = (await owner.query(`SELECT "fixtureId" AS f, generation::text AS g FROM "RevalFixtureBinding" WHERE "registrationId" = $1`, [r.registrationId])).rows[0];
    const fence = (await owner.query(`SELECT version::text AS v FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WS])).rows[0].v as string;
    const out = { gen: (b?.g as string) ?? null, fixture: (b?.f as string) ?? null, keys: JSON.stringify(await scopedKeys(q(owner), r)),
      preserved: await preservedFingerprint(q(owner)), fence };
    await owner.query('COMMIT');
    return out;
  } catch (e) { await owner.query('ROLLBACK').catch(() => undefined); throw e; }
}
/** Owner DML inside one transaction with the registered scope set (FORCE RLS applies to a non-superuser owner). */
export async function ownerTx<T>(owner: pg.Client, fn: () => Promise<T>): Promise<T> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
    const out = await fn(); await owner.query('COMMIT'); return out;
  } catch (e) { await owner.query('ROLLBACK').catch(() => undefined); throw e; }
}
