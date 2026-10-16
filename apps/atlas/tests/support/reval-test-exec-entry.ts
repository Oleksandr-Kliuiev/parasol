// TEST-ONLY executor entry (R-EVAL RS-A): the production executor library with the Docker TCP seam and test hooks.
// argv[2] = 0600 test JSON (TestTcp). Probes its inherited descriptors at first JS entry when asked.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { TestTcp } from './reval-test-deps.ts';
import { probeDescriptors, tcpVerify } from './reval-test-deps.ts';

const t0 = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as TestTcp;
const t: TestTcp = { ...t0, databaseOverride: t0.execDatabase };
if (t.fdProbeFile) writeFileSync(t.fdProbeFile, JSON.stringify({ role: 'E', pid: process.pid, fds: probeDescriptors() }));
const { runExecutorProcess, REVISE_SQL } = await import('../../packages/reval/owner-exec.ts');
const { readSecretFile } = await import('../../packages/reval/secret-file.ts');
const { APPLICATION_NAME } = await import('../../packages/reval/codes.ts');
const h = t.hooks ?? {};
const capture = (line: string) => { if (t.captureFile) appendFileSync(t.captureFile, `${line}\n`); };
const reviseSql = h.reviseZeroRows ? REVISE_SQL.replace('WHERE p."workspaceId" = $1', 'WHERE false AND p."workspaceId" = $1')
  : h.argDifference ? REVISE_SQL.replace(`p."expiresAt")::text`, `p."expiresAt" - interval '1 microsecond')::text`)
  : h.activeNoop ? REVISE_SQL.replace(`p."policyVersion", 'PAUSED'`, `p."policyVersion", p.state`) : undefined;
await runExecutorProcess({
  readSecret: readSecretFile,
  connect: async (request, password, connectTimeoutMs, budgetMs) => {
    if (h.blackholePort) {
      // Blocked before connect: a socket that accepts and never answers.
      await new Promise<never>(() => { createConnection({ host: '127.0.0.1', port: h.blackholePort! }); });
    }
    const { client } = await tcpVerify(t, request.endpoint, request.physical, request.ownerRole, password, APPLICATION_NAME.owner, budgetMs, undefined, connectTimeoutMs);
    const query = client.query.bind(client);
    client.query = (async (sql: string, params?: unknown[]) => {
      const r = await query(sql, params);
      capture(JSON.stringify({ sql: sql.includes('atlas_ask_remote_policy_revise') ? 'REVISE' : sql.replace(/\s+/g, ' ').slice(0, 60), rows: r.rows }));
      if (h.sleepInTxMs && sql.includes('FOR UPDATE')) await new Promise(res => setTimeout(res, h.sleepInTxMs));
      return r;
    }) as typeof client.query;
    return client;
  },
  hooks: {
    skipScope: h.skipScope, reviseSql,
    beforeCommit: h.rollbackBeforeCommit ? async () => { throw new Error('injected rollback before COMMIT'); } : undefined,
    commit: h.ackLostAfterCommit ? async c => { await c.query('COMMIT'); throw new Error('acknowledgement lost'); }
      : h.killAfterCommitSent ? async c => { void c.query('COMMIT'); await new Promise(r => setTimeout(r, 30)); process.kill(process.pid, 'SIGKILL'); } : undefined,
  },
});
