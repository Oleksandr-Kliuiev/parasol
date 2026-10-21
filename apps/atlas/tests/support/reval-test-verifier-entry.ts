// TEST-ONLY fixture verifier entry (R-EVAL RS-B): the production verifier library with the Docker TCP seam (UTC timestamp
// decoding as in production). argv[2] = 0600 test JSON (TestTcp). Hooks: sleep after connecting (concurrent binding change)
// with a start marker; RS-C-A (RS-B N1): connect as another role (the owner); stall the first source read past its timeout.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestTcp } from './reval-test-deps.ts';
import { tcpVerify } from './reval-test-deps.ts';

const t = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as TestTcp;
const { runVerifierProcess } = await import('../../packages/reval/verifier-exec.ts');
const { readSecretFile } = await import('../../packages/reval/secret-file.ts');
const { APPLICATION_NAME } = await import('../../packages/reval/codes.ts');
const { UTC_TYPES } = await import('../../packages/reval/pg-tx.ts');
// Test diagnostics only: V answers a bare INTERNAL_FAILURE for an unexpected error, so the cause is kept next to this test's
// config (0600, class, code and message; no secret reaches a pg error) for the test to show when a check fails.
const note = (stage: string, error: unknown): void => {
  const e = error as { name?: string; code?: string; message?: string } | null;
  try {
    appendFileSync(join(dirname(process.argv[2]!), 'verifier-errors.log'),
      `${stage}: ${e?.name ?? typeof error} ${e?.code ?? '-'} ${String(e?.message ?? error).slice(0, 300)}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
};
await runVerifierProcess({
  readSecret: async path => { try { return await readSecretFile(path); } catch (e) { note('readSecret', e); throw e; } },
  connect: async (request, password, connectTimeoutMs, budgetMs) => { try { return await connect(request, password, connectTimeoutMs, budgetMs); }
    catch (e) { note(`connect (timeout ${connectTimeoutMs} ms, budget ${budgetMs} ms)`, e); throw e; } },
});

async function connect(request: Parameters<Parameters<typeof runVerifierProcess>[0]['connect']>[0], password: string, connectTimeoutMs: number, budgetMs: number) {
  const role = t.hooks?.verifierRole ?? request.runtimeRole;
  const secret = t.hooks?.verifierRole ? (await readSecretFile(join(dirname(process.argv[2]!), 'secrets', 'owner'))).toString('latin1') : password;
  const { client } = await tcpVerify(t, request.endpoint, request.physical, role, secret, APPLICATION_NAME.verifier, budgetMs, undefined,
    connectTimeoutMs, UTC_TYPES);
  if (t.hooks?.verifierMarkerFile) writeFileSync(t.hooks.verifierMarkerFile, 'connected');
  if (t.hooks?.verifierSleepMs) await new Promise(r => setTimeout(r, t.hooks!.verifierSleepMs));
  if (t.hooks?.verifierStallSourceRead) {
    const query = client.query.bind(client); let stalled = false;
    client.query = (async (sql: string, params?: unknown[]) => {
      // The accepted Ask reader's observation statement (its RawEvent join is unique to readDbSource; the inventory reads the
      // same table earlier): a server-side cancellation (57014) well inside V's budget, the timeout lowered for this one statement.
      if (!stalled && sql.includes('JOIN public."RawEvent" e ON e."workspaceId" = o."workspaceId"')) { stalled = true; await query('SET LOCAL statement_timeout = 50'); await query('SELECT pg_catalog.pg_sleep(30)'); }
      return query(sql, params);
    }) as typeof client.query;
  }
  const query = client.query.bind(client);
  client.query = (async (sql: string, params?: unknown[]) => {
    try { return await query(sql, params); } catch (e) { note('query', e); throw e; }
  }) as typeof client.query;
  return client;
}
