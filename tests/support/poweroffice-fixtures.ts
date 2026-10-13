import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';

/**
 * Synthetic Stage 4 PowerOffice fixtures: TRUSTED TEST SUPPORT ONLY (docs/stage4/IMPLEMENTATION_HANDOFF.md item 7). The owner
 * inserts FIXTURE PowerOffice connections with the fixed synthetic binding and recorded provenance directly; there is no
 * CLI, onboarding or bind/activate path for PowerOffice. Actors/tokens are owner-written before services run. PowerOffice
 * rows are observed only through the confined runtime (or a deliberately confined role) under an explicit scope.
 */
export const WS = 'po-ws'; export const WX = 'po-ws-other';
export const CA = 'po-client-a'; export const CB = 'po-client-b'; export const CX = 'po-client-x';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const COMPANY_UUID: Record<string, string> = { 'po-a': uuid(1), 'po-a2': uuid(2), 'po-disabled': uuid(3), 'po-b': uuid(4), 'po-x': uuid(5), 'po-unbound': uuid(6) };
export const companyKey = (connection: string) => `synthetic-po-${COMPANY_UUID[connection]}`;

export interface PoKey { workspaceId: string; clientId: string; connectionId: string }
export const KEY_A: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-a' };
export const KEY_A2: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-a2' };
export const KEY_DISABLED: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-disabled' };
export const KEY_B: PoKey = { workspaceId: WS, clientId: CB, connectionId: 'po-b' };
export const KEY_X: PoKey = { workspaceId: WX, clientId: CX, connectionId: 'po-x' };

const READ = ['context:read', 'poweroffice:read'];
/** Actor → memberships (client → permissions). Separate memberships never merge; no automatic PowerOffice grants exist. */
export const PO_ACTORS: Record<string, { workspace: string; status?: string; workspacePermissions?: string[]; memberships: Record<string, string[]> }> = {
  reader: { workspace: WS, memberships: { [CA]: READ, [CB]: READ } },
  syncer: { workspace: WS, memberships: { [CA]: [...READ, 'poweroffice:sync'] } },
  maintainer: { workspace: WS, memberships: { [CA]: [...READ, 'poweroffice:maintain'] } },
  contextOnly: { workspace: WS, memberships: { [CA]: ['context:read'] } },
  poOnly: { workspace: WS, memberships: { [CA]: ['poweroffice:read', 'poweroffice:sync', 'poweroffice:maintain'] } },
  split: { workspace: WS, memberships: { [CA]: ['context:read'], [CB]: ['poweroffice:read', 'poweroffice:sync'] } },
  admin: { workspace: WS, workspacePermissions: ['security_audit:read'], memberships: {} },
  disabled: { workspace: WS, status: 'DISABLED', memberships: { [CA]: [...READ, 'poweroffice:sync', 'poweroffice:maintain'] } },
  outsider: { workspace: WX, memberships: { [CX]: [...READ, 'poweroffice:sync', 'poweroffice:maintain'] } },
};
export const tokens: Record<string, string> = Object.fromEntries(Object.keys(PO_ACTORS).map(a => [a, generateToken()]));

export async function addPowerOfficeFixtures(owner: pg.Client): Promise<void> {
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'PowerOffice workspace'), ($2, 'Other PowerOffice workspace')`, [WS, WX]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'A'), ($1, $3, 'B'), ($4, $5, 'X')`, [WS, CA, CB, WX, CX]);
  for (const [id, spec] of Object.entries(PO_ACTORS)) {
    await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName", status, "workspacePermissions") VALUES ($1, $2, 'Synthetic actor', $3, $4)`,
      [spec.workspace, id, spec.status ?? 'ACTIVE', spec.workspacePermissions ?? []]);
    for (const [client, permissions] of Object.entries(spec.memberships)) {
      await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [spec.workspace, client, id, permissions]);
    }
    await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [spec.workspace, `tok-${id}`, id, hashToken(tokens[id]!)]);
  }
  // [workspace, client, id, system, status, lifecycleVersion, bound]: the synthetic binding with provenance, plus refusal cases.
  const connections: [string, string, string, string, string, number, boolean][] = [
    [WS, CA, 'po-a', 'poweroffice', 'FIXTURE', 1, true], [WS, CA, 'po-a2', 'poweroffice', 'FIXTURE', 1, true],
    [WS, CA, 'po-disabled', 'poweroffice', 'DISABLED', 2, true], [WS, CB, 'po-b', 'poweroffice', 'FIXTURE', 1, true],
    [WX, CX, 'po-x', 'poweroffice', 'FIXTURE', 1, true], [WS, CA, 'po-unbound', 'poweroffice', 'FIXTURE', 1, false],
    [WS, CA, 'atera-a', 'atera', 'FIXTURE', 1, true]];
  for (const [w, c, id, system, status, version, bound] of connections) {
    const company = COMPANY_UUID[id] ?? uuid(99);
    await owner.query(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status,"boundBy","boundAt","lifecycleVersion")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [w, c, id, system, system === 'poweroffice' ? `synthetic-po-${company}` : `cust-${id}`,
      system === 'poweroffice' ? `fixture://poweroffice/${company}` : 'fixture://none', status, bound ? 'operator' : null, bound ? new Date() : null, version]);
  }
}

export async function connect(url: string): Promise<pg.Client> { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; }
export interface TxScope { workspaceId: string; clientIds: string; connectionId?: string; actorId?: string }
/** One explicit transaction with transaction-local scope settings; rolled back on error. */
export async function inTx<T>(client: pg.Client, scope: TxScope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true),
      set_config('app.poweroffice_connection_id', $3, true), set_config('app.actor_id', $4, true)`,
      [scope.workspaceId, scope.clientIds, scope.connectionId ?? '', scope.actorId ?? '']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
/** Runs `fn` (every statement must succeed) and returns the SQLSTATE raised by COMMIT itself; undefined when it committed. */
export async function commitState(client: pg.Client, scope: TxScope, fn: (c: pg.Client) => Promise<unknown>): Promise<string | undefined> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true),
      set_config('app.poweroffice_connection_id', $3, true), set_config('app.actor_id', $4, true)`,
      [scope.workspaceId, scope.clientIds, scope.connectionId ?? '', scope.actorId ?? '']);
    await fn(client);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  try { await client.query('COMMIT'); return undefined; } catch (error) { return stateOf(error) ?? 'NO_SQLSTATE'; }
}
export const scopeOf = (key: PoKey, actorId = 'syncer'): TxScope => ({ workspaceId: key.workspaceId, clientIds: key.clientId, connectionId: key.connectionId, actorId });
/** SQLSTATE of a failed pg query (or undefined). */
export const stateOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return undefined; } catch (error) { return stateOf(error) ?? 'NO_SQLSTATE'; }
}
