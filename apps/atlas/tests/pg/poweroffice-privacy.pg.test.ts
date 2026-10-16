import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWEROFFICE_AUDIT_KEYS } from '../../packages/poweroffice/audit.ts';
import { createTestDatabase, projectRoot } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, audits, denials, observe, syntheticInvoiceIds } from '../support/poweroffice-sync.ts';

// S4-B privacy on PostgreSQL 17 through the real MOCK composition, run in a child process (tests/support/poweroffice-privacy-
// child.ts) whose actual stdout/stderr are captured: a synthetic network trap (Node sockets and fetch) with a positive
// self-control on a local endpoint, payload-free receipts, code-only errors; then a whole-database scan proving that no invoice ID,
// export ID or company key left the transient pass, six-key client audit metadata and code-only errors. The actual HTTP/CLI
// journeys and their privacy capture are S4-C.
const pgdb = await createTestDatabase();
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });

const CHILD = fileURLToPath(new URL('../support/poweroffice-privacy-child.ts', import.meta.url));

test('child process: network trap positive control seen; sync, failure, refusals, recovery make zero network calls and write nothing to stdout/stderr', async () => {
  await addSyncConnection(owner, key('pv-ok'), 250);
  await addSyncConnection(owner, key('pv-bad'), 250);
  await addSyncConnection(owner, key('pv-held'), 3);
  const dir = await mkdtemp(join(tmpdir(), 'atlas-s4b-privacy-'));
  try {
    const result = join(dir, 'result.json');
    const child = spawnSync(process.execPath, ['--experimental-strip-types', CHILD], { cwd: projectRoot, encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', PO_PRIVACY_RUNTIME_URL: pgdb.runtimeUrl, PO_PRIVACY_SYNCER: tokens.syncer!, PO_PRIVACY_READER: tokens.reader!,
        PO_PRIVACY_CLIENT: CA, PO_PRIVACY_RESULT: result } });
    assert.equal(child.status, 0, `child exit ${child.status} ${child.signal ?? ''}`);
    assert.equal(child.stdout, '', 'nothing on stdout'); assert.equal(child.stderr, '', 'nothing on stderr');
    const r = JSON.parse(await readFile(result, 'utf8')) as { control: string[]; seen: string[]; receipts: string[][]; errors: Record<string, unknown>[] };
    assert.ok(r.control.includes('fetch') && r.control.includes('socket') && r.control.includes('synthetic'), `positive control: ${r.control.join(',')}`);
    assert.deepEqual(r.seen, [], 'zero sockets, zero fetch during the S4-B flows');
    const receiptKeys = ['attemptId', 'connectionId', 'idempotent', 'sequence', 'snapshotId', 'state', 'synthetic'];
    assert.deepEqual(r.receipts, [receiptKeys, receiptKeys, ['attemptId', 'claim', 'failure', 'sequence']], 'payload-free receipts');
    assert.deepEqual(r.errors.map(e => e.code), ['POWEROFFICE_DTO_INVALID', 'PERMISSION_DENIED', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_RECOVERY_NOT_DUE',
      'POWEROFFICE_CONNECTION_UNAVAILABLE']);
    for (const e of r.errors) assert.deepEqual([e.message, e.details, e.cause, e.keys], [e.code, {}, null, ['code', 'details', 'kind', 'name']], 'code-only error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('no invoice ID, export ID or company key outside the Connection binding anywhere in the database; summaries only aggregate; audits six keys', async () => {
  const secrets: string[] = [];
  for (const id of ['pv-ok', 'pv-bad']) {
    const o = await observe(runtime, key(id));
    const companyKey = (await owner.query(`SELECT "externalTenantId" AS k FROM "Connection" WHERE id = $1`, [id])).rows[0].k as string;
    for (const a of o.attempts as { id: string }[]) {
      const asOf = (await owner.query(`SELECT to_char("startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM "PowerOfficeAttempt" WHERE id = $1::uuid`, [a.id])).rows[0].t;
      secrets.push(...await syntheticInvoiceIds(id, companyKey, asOf, a.id));
    }
    secrets.push(companyKey, companyKey.slice('synthetic-po-'.length));
  }
  assert.ok(secrets.length > 500);
  const tables = (await owner.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map(r => r.t as string);
  assert.deepEqual(tables.filter(t => /poweroffice/i.test(t)), ['PowerOfficeAttempt', 'PowerOfficeSnapshot', 'PowerOfficeState'], 'no staging or page table');
  const leaks: string[] = [];
  for (const table of tables) {
    const text = (await owner.query(`SELECT coalesce(string_agg(t::text, E'\\n'), '') AS dump FROM public."${table}" t ${table === 'Connection' ? `WHERE system <> 'poweroffice'` : ''}`)).rows[0].dump as string;
    for (const s of secrets) if (text.includes(s)) leaks.push(`${table}:${s.slice(0, 8)}`);
  }
  assert.deepEqual(leaks, []);
  for (const snap of (await observe(runtime, key('pv-ok'))).snapshots as { summary: Record<string, unknown> }[]) {
    assert.deepEqual(Object.keys(snap.summary).sort(), ['currencies', 'totalCount']);
  }
  const rows = await audits(owner);
  assert.ok(rows.length >= 6);
  for (const r of rows) {
    assert.ok(Object.keys(r.metadata).every(k => (POWEROFFICE_AUDIT_KEYS as readonly string[]).includes(k)), JSON.stringify(r.metadata));
    for (const v of Object.values(r.metadata) as string[]) assert.doesNotMatch(v, /^\d+\.\d{2}$|^\d{4}-\d{2}-\d{2}|synthetic-po-/, 'no amount, date or company key');
  }
  assert.deepEqual([...new Set(rows.map(r => r.eventType))].sort(), ['poweroffice.sync.failed', 'poweroffice.sync.started', 'poweroffice.sync.succeeded']);
  for (const d of await denials(owner)) assert.deepEqual(d.metadata, {}, 'workspace denials carry no metadata');
});
