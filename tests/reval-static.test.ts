import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { FENCE_SHARED_INVOKER_ROUTINES } from '../packages/graph/fence-role.ts';
import { REVAL_DEFINER_COLUMNS } from '../packages/graph/reval-role.ts';
import { COMPLETION_RATE, PROMPT_RATE, RESERVE_MICRO_USD } from '../packages/reval/payloads.ts';

// R-EVAL RS-A static checks (ACCEPTANCE_CHECKS.md): production code never reaches test support or a TCP/TTY/peer
// relaxation; SQL/TS allowlists are byte-equal; accepted pricing literals; every name in the new routines is qualified.
const read = (rel: string) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const productionFiles = async (): Promise<string[]> => [
  ...(await readdir(new URL('../packages/reval/', import.meta.url))).filter(f => f.endsWith('.ts')).map(f => `packages/reval/${f}`),
  ...(await readdir(new URL('../scripts/reval-server/', import.meta.url))).filter(f => f.endsWith('.ts')).map(f => `scripts/reval-server/${f}`),
  'apps/api/src/reval/bridge.ts', 'apps/api/src/main.ts'];

test('production R-EVAL modules and entries import no test support and carry no TCP, fixture, TTY or peer relaxation selector', async () => {
  const files = await productionFiles();
  assert.ok(files.length >= 24, String(files.length));
  for (const f of files) {
    const text = await read(f);
    for (const forbidden of ['tests/', 'reval-test', 'rsa-test-tcp', 'NATIVE_PG_FIXTURE', 'TCP_LOOPBACK', 'ATLAS_PG_ADMIN_URL', 'skipPeer', 'allowTcp', 'noTty']) {
      assert.ok(!text.includes(forbidden), `${f} contains ${forbidden}`);
    }
    // main.ts keeps its accepted reads; bridge.ts re-checks ATLAS_MODE in the post-.env process env (its launch snapshot is
    // the whole-object copy LAUNCH_ENV); no other production module names an env variable directly.
    const allowedEnv: Record<string, string[]> = {
      // Deployment (docs/deploy/DEPLOY.md): ATLAS_LISTEN_HOST and ATLAS_ALLOWED_HOSTS, read only outside bridge mode (asserted below).
      'apps/api/src/main.ts': ['ATLAS_REVAL_BRIDGE_FD', 'ATLAS_MODE', 'ATLAS_API_PORT', 'ATLAS_ASK_MODE', 'ATLAS_OPERATOR_UI', 'ATLAS_RUNTIME_DATABASE_URL', 'ATLAS_DEMO_TOKEN',
        'ATLAS_LISTEN_HOST', 'ATLAS_ALLOWED_HOSTS'],
      'apps/api/src/reval/bridge.ts': ['ATLAS_MODE'],
    };
    for (const m of text.matchAll(/process\.env\.([A-Z_]+)/g)) assert.ok((allowedEnv[f] ?? []).includes(m[1]!), `${f} reads ${m[1]}`);
  }
  // The deployment reads (listen host, Host allowlist, proxy identity) never happen in bridge mode: each is behind `bridge ?`.
  const main = await read('apps/api/src/main.ts');
  for (const name of ['process.env.ATLAS_LISTEN_HOST', 'process.env.ATLAS_ALLOWED_HOSTS', 'proxyIdentityFromEnv(process.env)']) {
    const lines = main.split('\n').filter(l => l.includes(name) && !l.trimStart().startsWith('//'));
    assert.ok(lines.length === 1 && /bridge \? /.test(lines[0]!), `main.ts reads ${name} only outside bridge mode`);
  }
  assert.ok(/if \(mode === 'db' && !bridge\) app\.use\(proxyIdentityMiddleware\(proxyIdentity\)\);/.test(main), 'no proxy identity in bridge mode');
  const controller = await read('packages/reval/controller.ts');
  assert.deepEqual([...controller.matchAll(/env\.(ATLAS_[A-Z_]+)/g)].map(m => m[1]), ['ATLAS_REVAL_CONFIG', 'ATLAS_REVAL_CONNECTION_ID', 'ATLAS_REVAL_SERVER_BOOT_ID']);
  const config = await read('packages/reval/config.ts');
  assert.ok(!/['"]host['"]/.test(config) && !/transport/.test(config), 'the owner config schema has no host or transport field');
  const physical = await read('packages/reval/physical.ts');
  const code = physical.replace(/^\s*(\*|\/\/).*$/gm, '');
  assert.deepEqual([...code.matchAll(/host: ([^,;}]+)/g)].map(m => m[1]!.trim()), ['string', 'exp.endpoint.socketDir'], 'the client only gets the socket directory');
  const codes = await read('packages/reval/codes.ts');
  assert.equal([...codes.matchAll(/rsa-[a-z-]+-v1/g)].length, 2, 'exactly the production platform ref and the server inner-ack ref');
});

const sqlArray = (sql: string, name: string): string[] => {
  const start = sql.indexOf(`${name} TEXT[] := ARRAY[`); assert.ok(start >= 0, name);
  const body = sql.slice(sql.indexOf('[', start) + 1, sql.indexOf('];', start));
  return [...body.matchAll(/'([^']*)'/g)].map(m => m[1]!);
};
test('v_reval_shared is byte-equal to FENCE_SHARED_INVOKER_ROUTINES and roles.sql v_fence_shared; definer columns equal the TS allowlist', async () => {
  const reval = await read('prisma/roles/reval.sql'); const roles = await read('prisma/roles.sql');
  assert.deepEqual(sqlArray(reval, 'v_reval_shared'), [...FENCE_SHARED_INVOKER_ROUTINES]);
  assert.deepEqual(sqlArray(reval, 'v_reval_shared'), sqlArray(roles, 'v_fence_shared'));
  assert.deepEqual(sqlArray(reval, 'v_def_column'), Object.entries(REVAL_DEFINER_COLUMNS).flatMap(([t, cols]) => cols.map(c => `${t}:${c}`)));
  assert.equal(roles.split('\n').filter(l => l === '\\ir roles/reval.sql').length, 1, 'one include, inside the transaction');
  assert.ok(roles.indexOf('\\ir roles/reval.sql') < roles.lastIndexOf('COMMIT;'));
});

test('pricing literals 275/825/300000 are exactly the accepted RemoteAskAttempt/RemoteAskPolicy CHECK text', async () => {
  const m = await read('prisma/migrations/202610111010_stage5_ask_remote_state/migration.sql');
  assert.ok(m.includes(`"reservedMicroUsd" = ${RESERVE_MICRO_USD} AND "promptRate" = ${PROMPT_RATE} AND "completionRate" = ${COMPLETION_RATE}`));
  assert.ok(m.includes(`"reserveMicroUsd" = ${RESERVE_MICRO_USD}`));
});

test('every relation and function in atlas_reval_snapshot()/atlas_reval_guard() is schema-qualified (a pg_temp shadow cannot redirect)', async () => {
  const m = await read('prisma/migrations/202610131000_stage5_reval_registration/migration.sql');
  const bodies = [...m.matchAll(/AS \$fn\$([\s\S]*?)\$fn\$/g)].map(x => x[1]!);
  assert.equal(bodies.length, 2);
  const constructs = new Set(['coalesce', 'exists', 'in', 'any', 'array', 'values', 'not', 'and', 'or', 'then', 'else', 'when', 'case', 'select', 'from', 'where', 'with',
    'union', 'over', 'filter', 'using', 'raise', 'if', 'elsif', 'return', 'perform', 'into', 'as', 'by', 'on', 'join', 'is', 'distinct', 'null']);
  for (const body of bodies) {
    const code = body.replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, '');
    for (const r of code.matchAll(/(?<!DISTINCT\s)\b(?:FROM|JOIN)\s+("?[A-Za-z_][A-Za-z0-9_]*"?)(\.)?/g)) {
      assert.ok(r[2] === '.' || /^(rp|pr|pg_catalog)$/.test(r[1]!) || r[1] === '(', `unqualified relation ${r[1]}`);
    }
    for (const f of code.matchAll(/(^|[^.\w"])([a-z_][a-z0-9_]*)\s*\(/gi)) {
      assert.ok(constructs.has(f[2]!.toLowerCase()) || ['rp', 'pr'].includes(f[2]!), `unqualified function ${f[2]}`);
    }
  }
});
