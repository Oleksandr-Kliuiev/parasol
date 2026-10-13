import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProcessCensus } from '../../packages/reval/census-payloads.ts';
import { dbInventory } from '../../packages/reval/platform.ts';
import { loggingDisabled, readPgLogging } from '../../packages/reval/privacy-scan.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { askPath, browserHeaders, evalSandbox, FX02_CASES, handoffPath, pairAndArm, post, question, startEvalServer } from '../support/reval-eval-server.ts';
import type { EvalServer, Sandbox } from '../support/reval-eval-server.ts';
import { install, NO_REGISTERED_ROLES, pidOf, WS } from '../support/reval-fixture-pg.ts';
import { adminUrl } from '../support/pg-harness.ts';

// R-EVAL RS-D-A on real PG17 (rs-d brief A §3, §5): the guard census of the BUILT bridge composition (census-wrapped seams, the shared
// ingress budget) for capability, rejected and armed traffic — a scripted OFFLINE dispatch and a no-key bridge server (the in-process
// NO_DISPATCH proof) — and owner decision D2: the fixture switch admits the registered S (runtime role) and C (reader role) sessions
// only while idle. Synthetic data only; loopback only.
const skip = !process.env.ATLAS_PG_ADMIN_URL;
let sb: Sandbox; let srv: EvalServer; let noKey: EvalServer;
before(async () => { if (skip) return; sb = await evalSandbox({ singleActor: true }); srv = await startEvalServer(sb); noKey = await startEvalServer(sb, { bridgeSeams: true }); });
after(async () => { await noKey?.close(); await srv?.close(); await sb?.ns.cleanup(); });
const censusOf = (s: EvalServer): ProcessCensus => { const c = s.runtime.processCensus(); assert.equal(typeof c, 'object', String(c)); return c as ProcessCensus; };
/** The census once every physical owner of `s` is released (bounded). */
async function idle(s: EvalServer): Promise<ProcessCensus> {
  for (let i = 0; i < 40; i += 1) { const c = censusOf(s); if (c.activeTaskCount === '0' && c.pendingCommitCount === '0') return c; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('owners never released');
}
const delta = (a: ProcessCensus, b: ProcessCensus) => (k: keyof ProcessCensus) => Number(BigInt(b[k] as string) - BigInt(a[k] as string));

test('guard census of the built bridge composition: capability, rejected and armed traffic; dispatch vs the no-key in-process NO_DISPATCH proof', { skip }, async () => {
  const c0 = await idle(srv);
  assert.deepEqual([c0.coverage, c0.submitIngressCount, c0.tasks], ['COMPLETE', '0', []]);
  const cap = await post(srv.port, '/ask/capabilities', null, { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${sb.tokens.actor}` }, 'GET');
  assert.equal(cap.status, 200, cap.body);
  const c1 = await idle(srv); let d = delta(c0, c1);
  assert.deepEqual([d('capabilityIngressCount'), d('physicalReleaseCount'), d('submitIngressCount')], [1, 1, 0], 'a capability request takes and releases one owner');
  // rc2 N6: every handoff-shaped entry counts before any check — another method, another client's path.
  assert.equal((await post(srv.port, handoffPath, null, { host: `127.0.0.1:${srv.port}` }, 'GET')).status, 404);
  assert.equal((await post(srv.port, '/clients/syn-client-other/ask/evaluation-handoff', '{}', browserHeaders(srv.port, sb.tokens.actor))).status, 404);
  const ch = await idle(srv); assert.deepEqual([delta(c1, ch)('handoffIngressCount'), delta(c1, ch)('submitIngressCount')], [2, 0]);
  const rejected = await post(srv.port, askPath, '{}', browserHeaders(srv.port, sb.tokens.actor));
  assert.equal(rejected.status, 503);
  const c2 = await idle(srv); d = delta(ch, c2);
  assert.deepEqual([d('submitIngressCount'), d('rejectedUnpairedCount'), d('publicationCount'), d('physicalReleaseCount')], [1, 1, 0, 0], 'rejected before any owner');
  const a = await pairAndArm(srv, sb);
  const q = await question(srv, sb, a);
  assert.equal(q.res.status, 200, q.res.body);
  const c3 = await idle(srv); d = delta(c2, c3);
  assert.deepEqual(['submitIngressCount', 'reservationConfirmedCount', 'capabilityConsumedCount', 'transportEntryCount', 'publicationCount', 'physicalReleaseCount',
    'handoffIngressCount', 'unattributedCount', 'rejectedUnpairedCount'].map(k => d(k as never)), [1, 1, 1, 1, 1, 1, 1, 0, 0], 'one armed case: the scripted offline dispatch');
  const task = c3.tasks.find(t => t.correlationId === q.res.headers['x-atlas-correlation-id'])!;
  assert.deepEqual([task.reservation, task.capabilityConsumed, task.transportEntered, task.noDispatchProof, task.ownerReleased, task.publication],
    ['COMMITTED', true, true, 'UNAVAILABLE', true, 'ANSWER'], 'the uncollected record stays an item until C collects it');
  // The no-key bridge seams (production bridge composition): reserved, never consumed; NO_DISPATCH proven in process.
  const n0 = await idle(noKey);
  const b = await pairAndArm(noKey, sb, FX02_CASES[1]!);
  const nq = await question(noKey, sb, b);
  assert.deepEqual([nq.res.status, JSON.parse(nq.res.body).code], [503, 'ASK_REMOTE_UNAVAILABLE']);
  const n1 = await idle(noKey); d = delta(n0, n1);
  assert.deepEqual([d('reservationConfirmedCount'), d('capabilityConsumedCount'), d('transportEntryCount'), d('publicationCount')], [1, 0, 0, 1]);
  const proof = n1.tasks.find(t => t.correlationId === nq.res.headers['x-atlas-correlation-id'])!;
  assert.deepEqual([proof.capabilityConsumed, proof.noDispatchProof, proof.publication], [false, 'ORIGINAL_PRIVATE_PROOF', 'ERROR']);
  assert.equal(n1.guardEpoch, noKey.runtime.guardEpoch); assert.notEqual(n1.guardEpoch, c3.guardEpoch, 'one guard epoch per server process');
});

test('D2: the fixture switch admits only IDLE sessions of the registered runtime (S) and reader (C) roles with their fixed names; anything else refuses', { skip }, async () => {
  const owner = sb.ns.db.owner; const pid = await pidOf(owner);
  await revise(owner, WS, { state: 'PAUSED' });
  const roles = { runtime: sb.ns.db.runtimeRole, reader: sb.ns.db.revalReaderRole };
  const u = new URL(sb.ns.db.runtimeUrl);
  const connect = async (user: string, password: string, app: string) => {
    const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user, password, application_name: app }); await c.connect(); return c;
  };
  const reader = await connect(roles.reader, sb.ns.db.revalReaderPassword, 'atlas-reval-c-reader'); // C's idle confined reader
  const extra: pg.Client[] = [];
  const code = async (fx: string, gen: string, r = roles) => { try { await install(owner, sb.r, fx, gen, [pid], undefined, undefined, r); return 'OK'; } catch (e) { return (e as { code?: string }).code; } };
  try {
    await idle(srv); await idle(noKey);
    assert.equal(await code('FX05', '1', NO_REGISTERED_ROLES), 'ANOTHER_WRITER', 'the S pools and the C reader are there (RS-B semantics refuse them)');
    const inTx = await connect(roles.runtime, u.password, 'atlas-reval-s-runtime'); extra.push(inTx);
    await inTx.query('BEGIN'); await inTx.query('SELECT 1');
    assert.equal(await code('FX05', '1'), 'ANOTHER_WRITER', 'an S-named runtime session inside a transaction');
    await inTx.query('ROLLBACK');
    const named = await connect(roles.runtime, u.password, 'not-the-server'); extra.push(named);
    assert.equal(await code('FX05', '1'), 'ANOTHER_WRITER', 'a runtime session with another application_name');
    await named.end(); extra.splice(extra.indexOf(named), 1);
    await reader.query('SELECT pg_advisory_lock(7)');
    assert.equal(await code('FX05', '1'), 'ANOTHER_WRITER', 'a reader session holding a session lock');
    await reader.query('SELECT pg_advisory_unlock(7)');
    // rc2 (review F4): each fixed name only with its own registered role — never the other role, never an unregistered role.
    for (const [user, password, app, why] of [[roles.reader, sb.ns.db.revalReaderPassword, 'atlas-reval-s-runtime', 'the reader role under S\'s name'],
      [roles.runtime, u.password, 'atlas-reval-c-reader', 'the (writer-capable) runtime role under C\'s name'],
      [sb.ns.ownerRole, sb.ns.ownerPassword, 'atlas-reval-c-reader', 'an unregistered role under C\'s name'],
      [sb.ns.ownerRole, sb.ns.ownerPassword, 'atlas-reval-s-runtime', 'an unregistered role under S\'s name']] as const) {
      const swapped = await connect(user, password, app); extra.push(swapped);
      assert.equal(await code('FX05', '1'), 'ANOTHER_WRITER', why);
      await swapped.end(); extra.splice(extra.indexOf(swapped), 1);
    }
    const r = await install(owner, sb.r, 'FX05', '1', [pid], undefined, undefined, roles);
    assert.deepEqual([r.fixtureId, r.generation], ['FX05', '2'], 'with S (two servers, idle pools, one idle S-named session) and C idle, the switch commits');
  } finally { for (const c of extra) await c.end().catch(() => undefined); await reader.end().catch(() => undefined); }
});

test('RS-D-B DRAIN process inventory (dbInventory): COMPLETE only while every backend of the DB is S\'s runtime or C\'s reader session under its own fixed name; per-role logging overrides are seen', { skip }, async () => {
  // A throwaway database where every session is this test's own: the shared sandbox DB always holds the harness owner connection.
  const admin = new pg.Client({ connectionString: adminUrl() }); await admin.connect();
  const name = `atlas_it_inv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const roles = { runtime: sb.ns.db.runtimeRole, reader: sb.ns.db.revalReaderRole };
  const u = new URL(sb.ns.db.runtimeUrl); const open: pg.Client[] = [];
  const connect = async (user: string, password: string, app: string) => {
    const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), database: name, user, password, application_name: app }); await c.connect(); open.push(c); return c;
  };
  try {
    const reader = await connect(roles.reader, sb.ns.db.revalReaderPassword, 'atlas-reval-c-reader');
    assert.equal(await dbInventory(reader, roles), 'COMPLETE', 'only C\'s reader');
    await connect(roles.runtime, u.password, 'atlas-reval-s-runtime');
    assert.equal(await dbInventory(reader, roles), 'COMPLETE', 'and S\'s runtime session');
    for (const [user, password, app, why] of [[roles.runtime, u.password, 'not-the-server', 'a runtime session under another name'],
      [roles.reader, sb.ns.db.revalReaderPassword, 'atlas-reval-s-runtime', 'the reader role under S\'s name'],
      [roles.runtime, u.password, 'atlas-reval-c-reader', 'the runtime role under C\'s name'],
      [sb.ns.ownerRole, sb.ns.ownerPassword, 'atlas-reval-s-runtime', 'an unregistered (owner) role under S\'s name']] as const) {
      const x = await connect(user, password, app);
      assert.equal(await dbInventory(reader, roles), 'INCOMPLETE', why);
      await x.end(); open.splice(open.indexOf(x), 1);
    }
    assert.equal(await dbInventory(reader, roles), 'COMPLETE', 'back to S and C only');
    // rc2 (review F2): what applies to S's session, not only the reader's view — a per-role override in this DB is visible to the reader.
    const before = await readPgLogging(reader, roles);
    assert.deepEqual([before?.roleOverrides, Object.keys(before?.settings ?? {}).length], [0, 9], 'readable by the confined reader');
    await admin.query(`ALTER ROLE "${roles.runtime}" IN DATABASE ${name} SET log_statement = 'all'`);
    const after = await readPgLogging(reader, roles);
    assert.deepEqual([after?.roleOverrides, after?.settings.log_statement === before?.settings.log_statement, loggingDisabled(after)], [1, true, false],
      'the reader still sees the default, the override is counted → never DISABLED_AS_REQUIRED');
    await admin.query(`ALTER ROLE "${roles.runtime}" IN DATABASE ${name} RESET log_statement`);
    assert.equal((await readPgLogging(reader, roles))?.roleOverrides, 0);
    // RS-D-B rc2-N6: a (role, ALL databases) override applies to S's sessions here too — and for C's reader role likewise.
    for (const role of [roles.runtime, roles.reader]) {
      await admin.query(`ALTER ROLE "${role}" SET debug_print_plan = on`);
      try { assert.equal((await readPgLogging(reader, roles))?.roleOverrides, 1, `${role}: all-databases override counted`); }
      finally { await admin.query(`ALTER ROLE "${role}" RESET debug_print_plan`); }
    }
    assert.equal((await readPgLogging(reader, roles))?.roleOverrides, 0);
  } finally {
    for (const c of open) await c.end().catch(() => undefined);
    for (let i = 0; ; i += 1) { // no FORCE: wait (bounded) for the closed backends to leave
      try { await admin.query(`DROP DATABASE ${name}`); break; } catch (e) { if (i >= 40) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    await admin.end();
  }
});
