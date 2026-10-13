import pg from 'pg';
import { RESERVE_SQL, ledgerErrorCode, reserveParams } from '../../packages/ask/remote/ledger-sql.ts';

/**
 * TEST-ONLY child process for the ASK-REMOTE multi-process budget race (tests/pg/ask-remote-race.pg.test.ts). It connects
 * as the confined runtime role (URL from the environment, never printed), waits on a shared advisory-lock barrier held
 * exclusively by the parent, then runs ONE production egress-admission transaction (scope → fence FOR SHARE → reserve)
 * and prints a single JSON line: {"ok":true} or {"code":"ASK_REMOTE_…"} (fixed codes only, never error text).
 * argv: workspace client actor admissionId policyVersion priceRevision barrierKey
 */
const [workspace, client, actor, admissionId, policyVersion, priceRevision, barrier] = process.argv.slice(2) as string[];
const runtime = new pg.Client({ connectionString: process.env.ATLAS_RA_CHILD_URL });
let out: Record<string, unknown> = { code: 'UNKNOWN' };
try {
  await runtime.connect();
  await runtime.query('SELECT pg_advisory_lock_shared($1::bigint)', [barrier]);
  await runtime.query('SELECT pg_advisory_unlock_shared($1::bigint)', [barrier]);
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [workspace, client]);
  const fence = (await runtime.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [workspace])).rows[0].version as number;
  await runtime.query(RESERVE_SQL, reserveParams({ workspaceId: workspace!, clientId: client!, actorId: actor!, admissionId: admissionId!,
    policyVersion: policyVersion!, fenceVersion: fence, priceRevision: priceRevision!, correlationId: crypto.randomUUID() }));
  await runtime.query('COMMIT');
  out = { ok: true };
} catch (error) {
  await runtime.query('ROLLBACK').catch(() => undefined);
  out = { code: ledgerErrorCode(error) ?? 'UNEXPECTED' };
} finally {
  await runtime.end().catch(() => undefined);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
