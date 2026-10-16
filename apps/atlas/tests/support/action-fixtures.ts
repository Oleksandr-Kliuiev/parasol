import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { actionComposition } from '../../packages/actions/policy.ts';

/**
 * Synthetic Stage 3 S3-A fixtures (owner-written auth/Connection rows, created BEFORE runtime action services run) and
 * observation helpers. Action rows are observed only through the confined runtime role under an explicit workspace/client
 * scope; the owner never inspects FORCE action tables. Canary strings must never appear in public output or audit.
 */
export const WA = 'act-ws'; export const WB = 'act-ws-other';
export const CA = 'act-client-a'; export const CB = 'act-client-b'; export const CX = 'act-client-x';
export const CUSTOMER_CANARY = 'cust-CANARY-7f3e';
export const SECRET_REF = 'fixture://none';
export const MOCK = actionComposition({ ATLAS_ACTIONS_MODE: 'MOCK' });

const READ = ['context:read', 'actions:read'];
/** Actor → memberships (client → permissions). Separate memberships never merge. */
export const ACTION_ACTORS: Record<string, { workspace: string; memberships: Record<string, string[]> }> = {
  requester: { workspace: WA, memberships: { [CA]: [...READ, 'actions:request'], [CB]: [...READ, 'actions:request'] } },
  requester2: { workspace: WA, memberships: { [CA]: [...READ, 'actions:request'] } },
  reader: { workspace: WA, memberships: { [CA]: READ } },
  approver: { workspace: WA, memberships: { [CA]: [...READ, 'actions:approve'] } },
  contextOnly: { workspace: WA, memberships: { [CA]: ['context:read'] } },
  split: { workspace: WA, memberships: { [CA]: READ, [CB]: ['actions:request'] } },
  outsider: { workspace: WB, memberships: { [CX]: [...READ, 'actions:request'] } },
};
export type ActionActor = keyof typeof ACTION_ACTORS;
export const tokens: Record<string, string> = Object.fromEntries(Object.keys(ACTION_ACTORS).map(a => [a, generateToken()]));

export async function addActionFixtures(owner: pg.Client): Promise<void> {
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'Action workspace'), ($2, 'Other action workspace')`, [WA, WB]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'A'), ($1, $3, 'B'), ($4, $5, 'X')`, [WA, CA, CB, WB, CX]);
  const connections: [string, string, string, string, string, string][] = [
    [WA, CA, 'atera-a', 'atera', CUSTOMER_CANARY, 'FIXTURE'], [WA, CB, 'atera-b', 'atera', 'cust-b', 'FIXTURE'],
    [WA, CA, 'huntress-a', 'huntress', 'org-a', 'FIXTURE'], [WA, CA, 'atera-disabled', 'atera', 'cust-disabled', 'DISABLED'],
    [WB, CX, 'atera-x', 'atera', 'cust-x', 'FIXTURE']];
  for (const [w, c, id, system, tenant, status] of connections) {
    await owner.query(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [w, c, id, system, tenant, SECRET_REF, status]);
  }
  for (const [id, spec] of Object.entries(ACTION_ACTORS)) {
    await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor')`, [spec.workspace, id]);
    for (const [client, permissions] of Object.entries(spec.memberships)) {
      await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [spec.workspace, client, id, permissions]);
    }
    await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [spec.workspace, `tok-${id}`, id, hashToken(tokens[id]!)]);
  }
}

/** A connected client of the confined runtime role; `scoped` runs one transaction under an explicit scope. */
export async function runtimeClient(url: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }
export async function scoped<T = Record<string, unknown>>(runtime: pg.Client, workspace: string, clients: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [workspace, clients]);
    const rows = (await runtime.query(sql, params)).rows as T[];
    await runtime.query('COMMIT');
    return rows;
  } catch (error) { await runtime.query('ROLLBACK').catch(() => undefined); throw error; }
}
/** The workspace authority epoch, observed by the runtime under that workspace. */
export const fenceVersion = async (runtime: pg.Client, workspace: string): Promise<number | null> =>
  (await scoped<{ version: number }>(runtime, workspace, '', `SELECT version FROM public."ActionAuthorityFence"`))[0]?.version ?? null;

/** A private directory outside any checkout, for 0600 input files and preview outputs. */
export async function privateDir(): Promise<{ dir: string; input(value: unknown, name?: string): Promise<string>; out(name: string): string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-action-'));
  let n = 0;
  return {
    dir,
    async input(value: unknown, name = `input-${++n}.json`) { const p = join(dir, name); await writeFile(p, JSON.stringify(value), { mode: 0o600 }); return p; },
    out: (name: string) => join(dir, name),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
