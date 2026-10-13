import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import pg from 'pg';
import { nodePhysicalDeps, PHYSICAL_QUERY, verifyPhysicalEndpoint } from '../../packages/reval/physical.ts';
import { DeadlineExceeded } from '../../packages/reval/deadline.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRISMA_CLI, runWithDatabase } from '../support/pg-harness.ts';
import { readRolesSql, renderRolesSql, uniqueRoleNames, dropRolesSql, revalRoleNames } from '../support/roles-sql.ts';
import { PRICE, freshProject } from '../support/ask-remote-pg.ts';
import { registerSandbox } from '../support/reval-pg.ts';
import { NODE_REALPATH, privateDir, writeOwnerConfig } from '../support/reval-test-deps.ts';
import { PtySession, waitGone } from '../support/reval-pty.ts';

// R-EVAL RS-A native Unix PG17 PRODUCTION CHAIN (ACCEPTANCE_CHECKS "native Unix PG17"): with ATLAS_REVAL_NATIVE_PG_FIXTURE set
// to the root's descriptor, the UNMODIFIED production chain runs with NO test DI in any spawned process: production
// scripts/reval-server/owner.ts under a real PTY (/usr/bin/script) → production controller (productionDeps) → built
// dist/apps/api/src/main.js in bridge mode → production owner-exec.ts → the built helper pinned by sha256; real 0600 owner
// config in a 0700 realpath directory with the recorded physical tuple. Test-fixture evidence only: never MEASURED, never
// platform/image proof. The fixture admin only bootstraps; a dedicated NOSUPERUSER NOBYPASSRLS owner owns everything.
// Ad-hoc developer runs without the descriptor skip with reason NATIVE_UNIX_PG_FIXTURE_ABSENT; the evidence run sets it.
const fixturePath = process.env.ATLAS_REVAL_NATIVE_PG_FIXTURE;
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = !fixturePath ? 'NATIVE_UNIX_PG_FIXTURE_ABSENT' : !darwin ? 'darwin/arm64 only' : false;

interface Native { socketDir: string; port: number; dataDirectory: string; adminRole: string; adminSecretFile: string }
const fx: Native | null = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
const unixUrl = (user: string, password: string, database: string) =>
  `postgresql://${user}:${password}@localhost:${fx!.port}/${database}?host=${encodeURIComponent(fx!.socketDir)}`;
const connect = async (user: string, password: string, database: string) => {
  const c = new pg.Client({ host: fx!.socketDir, port: fx!.port, user, password, database }); await c.connect(); return c;
};

test('native production chain: IDENTITY (UNVERIFIED, rsa-peertoken-unixphys-v1), SNAPSHOT, APPLIED and NO-OP closures; socket/pid/OID negatives refuse before effects', { skip, timeout: 600000 }, async () => {
  const adminPw = readFileSync(fx!.adminSecretFile, 'utf8').trim();
  const admin = await connect(fx!.adminRole, adminPw, 'postgres');
  const suffix = randomBytes(4).toString('hex');
  const ownerRole = `atlas_rv_native_${suffix}`; const ownerPw = randomBytes(18).toString('hex'); const dbName = `atlas_rv_native_${suffix}`;
  const roles = uniqueRoleNames('nat', suffix);
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), poRunnerPassword: randomBytes(18).toString('hex'),
    revalReaderPassword: randomBytes(18).toString('hex') };
  const sessions: PtySession[] = [];
  after(async () => {
    for (const s of sessions) assert.deepEqual((await s.stop()).forced, [], 'no O/C/S/E process survives a native session');
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    for (const q of dropRolesSql(roles)) await admin.query(q).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });
  console.log(`# REVAL_EVIDENCE native fixture descriptor sha256=${createHash('sha256').update(readFileSync(fixturePath!)).digest('hex')}`);
  console.log(`# REVAL_EVIDENCE native server ${(await admin.query('SHOW server_version')).rows[0].server_version}`);
  // Bootstrap only: the dedicated non-superuser owner creates and owns the database, migrations and roles.
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPw}'`);
  const ownerPg = await connect(ownerRole, ownerPw, 'postgres');
  await ownerPg.query(`CREATE DATABASE "${dbName}"`); await ownerPg.end();
  runWithDatabase(unixUrl(ownerRole, ownerPw, dbName), process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  const owner = await connect(ownerRole, ownerPw, dbName);
  try {
    await owner.query(renderRolesSql(await readRolesSql(), roles, secrets));
    const flags = (await owner.query(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)`,
      [[ownerRole, roles.runtime, revalRoleNames(roles).reader]])).rows;
    assert.equal(flags.length, 3); assert.ok(flags.every(f => !f.rolsuper && !f.rolbypassrls), JSON.stringify(flags));
    console.log(`# REVAL_EVIDENCE native role flags ${JSON.stringify(flags.map(f => ({ super: f.rolsuper, bypassRls: f.rolbypassrls })))}`);
    const p = await freshProject(owner, `nat${suffix}`);
    const work = await privateDir('native');
    const helper = buildPeer(`${work}/peer`);
    const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
    const reg = await registerSandbox(owner, p, revalRoleNames(roles).reader, { buildManifestSha256: digests.buildManifestSha256 });
    // The recorded physical tuple: socket device/inode, postmaster.pid, system identifier and database OID.
    const sock = statSync(`${fx!.socketDir}/.s.PGSQL.${fx!.port}`);
    const pid = readFileSync(`${fx!.dataDirectory}/postmaster.pid`, 'utf8').split('\n');
    const facts = (await owner.query(`SELECT (pg_control_system()).system_identifier::text AS s, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS o`)).rows[0];
    const physical = { systemIdentifier: facts.s, databaseOid: facts.o, postmasterStartTime: pid[2]!, postmasterPid: pid[0]!, dataDirectory: fx!.dataDirectory,
      socketDevice: String(sock.dev), socketInode: String(sock.ino) };
    const queried = (await owner.query(PHYSICAL_QUERY)).rows[0].start_epoch as string;
    console.log(`# REVAL_EVIDENCE native start equality postmaster.pid=${pid[2]} pg_postmaster_start_time floor=${queried} equal=${queried === pid[2]}`);
    assert.equal(queried, pid[2], 'production physical query start epoch EQUALS the postmaster.pid start line (no tolerance)');
    const configFor = async (label: string, over: Partial<typeof physical> = {}, ownerPassword = ownerPw) => {
      const dir = await privateDir(`native-${label}`);
      return (await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: reg.registrationId, databaseInstanceId: reg.databaseInstanceId,
        workspaceId: p.ws, clientId: p.client, actorId: p.actor, admissionId: p.admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path,
        nativePeerHelperSha256: helper.sha256, endpoint: { socketDir: fx!.socketDir, port: fx!.port, database: dbName },
        roles: { reader: revalRoleNames(roles).reader, runtime: roles.runtime, owner: ownerRole }, physical: { ...physical, ...over },
        server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: 4100 + Math.floor(Math.random() * 400) } } as never,
        { reader: secrets.revalReaderPassword, runtime: secrets.runtimePassword, owner: ownerPassword })).path;
    };
    const production = `${PROJECT_ROOT}/scripts/reval-server/owner.ts`;
    const v = p.policyVersion; const v1 = String(BigInt(v) + 1n);
    const fence = String((await owner.query(`BEGIN; SELECT set_config('app.workspace_id', '${p.ws}', true); SELECT version FROM "ActionAuthorityFence"; COMMIT;`) as unknown as { rows: { version: number }[] }[])[2]!.rows[0]!.version);
    const ready = Array.from({ length: 15 }, () => 'identity');
    const s = new PtySession(await privateDir('native-pty'), production, ['--config', await configFor('ok')],
      [...ready, 'snapshot', `pause-export ${p.admissionId} ${v} 0 0`, `pause-export ${p.admissionId} ${v1} ${v} ${fence}`, 'quit']);
    sessions.push(s);
    const first = await s.waitFor(r => r.line.startsWith('OK IDENTITY '), 60000);
    const backends = (await admin.query(`SELECT application_name AS a, usename::text AS u, client_addr IS NULL AS unix FROM pg_stat_activity WHERE datname = $1
      AND application_name LIKE 'atlas-reval-%'`, [dbName])).rows;
    assert.ok(backends.some(b => b.a === 'atlas-reval-c-reader') && backends.some(b => b.a === 'atlas-reval-s-runtime'), JSON.stringify(backends));
    assert.ok(backends.every(b => b.unix), 'every RS-A backend is a unix-socket session');
    assert.ok(await s.exited(120000), 'session ended');
    const r = s.results.map(x => x.line);
    const id = JSON.parse(r[first]!.slice(r[first]!.indexOf('{')));
    assert.deepEqual([id.loadedBinding, id.platformEvidenceRef, id.databaseInstanceId, id.buildManifestSha256],
      ['UNVERIFIED', 'rsa-peertoken-unixphys-v1', reg.databaseInstanceId, digests.buildManifestSha256]);
    const k = ready.length;
    assert.match(r[k]!, /^OK SNAPSHOT /, r[k]); const snap = JSON.parse(r[k]!.slice(r[k]!.indexOf('{')));
    assert.deepEqual([snap.admissionId, snap.policyVersion, snap.policyState, snap.consistent], [p.admissionId, v, 'ACTIVE', true]);
    assert.equal(r[k + 1], `OK CLOSURE {"admissionId":"${p.admissionId}","paused":true,"policyVersion":"${v1}","fenceEpoch":"${String(Number(fence) + 1)}"}`, 'APPLIED');
    assert.equal(r[k + 2], `OK CLOSURE {"admissionId":"${p.admissionId}","paused":true,"policyVersion":"${v1}","fenceEpoch":"${String(Number(fence) + 1)}"}`, 'NO-OP');
    console.log(`# REVAL_EVIDENCE native closures APPLIED and NO-OP confirmed; identity ref ${id.platformEvidenceRef} loadedBinding ${id.loadedBinding}`);
    for (const pw of [secrets.runtimePassword, secrets.revalReaderPassword, ownerPw, adminPw]) assert.ok(!s.transcript.includes(pw), 'no credential in the transcript');
    // Negatives: each a fresh config/session; after the peer proof the controller answers every op with an authenticated
    // FAILURE REGISTRATION_MISMATCH (brief §3) and never launches S or E. The recorded start is the postmaster.pid line EXACTLY.
    for (const [label, over] of [['socket inode', { socketInode: String(sock.ino + 1) }], ['postmaster pid', { postmasterPid: String(Number(pid[0]) + 1) }],
      ['postmaster start -1 s', { postmasterStartTime: String(Number(pid[2]) - 1) }], ['postmaster start +1 s', { postmasterStartTime: String(Number(pid[2]) + 1) }], ['database OID', { databaseOid: String(Number(facts.o) + 1) }]] as const) {
      const before = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name IN ('atlas-reval-s-runtime', 'atlas-reval-e-owner')`, [dbName])).rows[0].n;
      const neg = new PtySession(await privateDir(`native-neg`), production, ['--config', await configFor(label.replace(/[^a-z0-9]+/g, '-'), over)], ['identity', 'snapshot', 'quit']);
      sessions.push(neg);
      await neg.waitFor((x, i) => i === 1 || x.line.startsWith('LOCAL ') || x.line.startsWith('OK '), 30000);
      assert.deepEqual(neg.results.map(x => x.line), ['FAILURE REGISTRATION_MISMATCH', 'FAILURE REGISTRATION_MISMATCH'], label);
      assert.equal(before, 0);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name IN ('atlas-reval-s-runtime', 'atlas-reval-e-owner')`, [dbName])).rows[0].n, 0,
        `${label}: no S or E session`);
      await neg.exited(15000);
    }
    // Sol R3 through the PRODUCTION E and physical connector: a wrong owner password → OWNER_REQUIRED twice (no latch), nothing changed.
    const pol = async () => ((await owner.query(`BEGIN; SELECT set_config('app.workspace_id', '${p.ws}', true); SELECT "policyVersion"::text AS v, state, f.version::text AS f
      FROM "RemoteAskPolicy", "ActionAuthorityFence" f; COMMIT;`)) as unknown as { rows: Record<string, string>[] }[])[2]!.rows[0]!;
    const polBefore = await pol();
    const wrong = new PtySession(await privateDir('native-wrong-owner'), production, ['--config', await configFor('wrong-owner', {}, 'WrongOwnerPassword0000000')],
      [`pause-export ${p.admissionId} ${polBefore.v} 0 0`, `pause-export ${p.admissionId} ${polBefore.v} 0 0`, 'quit']);
    sessions.push(wrong);
    assert.ok(await wrong.exited(60000));
    assert.deepEqual(wrong.results.map(x => x.line), ['FAILURE OWNER_REQUIRED', 'FAILURE OWNER_REQUIRED'], '28P01 kept; no latch: the second call spawns E again');
    assert.deepEqual(await pol(), polBefore, 'no lock effect, no revision');
    console.log('# REVAL_EVIDENCE native wrong owner password: FAILURE OWNER_REQUIRED x2, policy/fence unchanged');
    // Sol R1 on the REAL backend: the production physical query blocked by ACCESS EXCLUSIVE on pg_database (taken after the
    // connection exists) rejects at its budget; the client is destroyed and session statement_timeout cancels the backend.
    const locker = await connect(fx!.adminRole, adminPw, 'postgres');
    try {
      let backend = 0;
      const deps = nodePhysicalDeps(async o => {
        const c = new pg.Client(o); await c.connect(); backend = (c as unknown as { processID: number }).processID;
        await locker.query('BEGIN'); await locker.query('LOCK TABLE pg_catalog.pg_database IN ACCESS EXCLUSIVE MODE');
        return c as never;
      });
      const t = performance.now();
      const e = await verifyPhysicalEndpoint({ endpoint: { socketDir: fx!.socketDir, port: fx!.port, database: dbName }, physical, role: revalRoleNames(roles).reader,
        applicationName: 'atlas-reval-c-reader', budgetMs: 800 }, secrets.revalReaderPassword, deps).then(() => null, (x: unknown) => x);
      const ms = performance.now() - t;
      assert.ok(e instanceof DeadlineExceeded, String(e)); assert.ok(ms < 1000, `rejected after ${ms.toFixed(0)} ms`);
      // While the lock is still held: the backend's statement is CANCELLED (statement_timeout = budget; no longer in the Lock
      // wait). PostgreSQL's own backend teardown then waits for this superuser-held shared-catalog lock (probe evidence
      // checks/rc2/probes/native-lock-stall.log), so the process disappears once the lock is released.
      const waiting = async () => (await locker.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [backend])).rows[0].n as number;
      const t2 = Date.now(); while (Date.now() - t2 < 1500 && await waiting() > 0) await new Promise(r => setTimeout(r, 50));
      assert.equal(await waiting(), 0, 'the stalled statement was cancelled while the lock is still held');
      const cancelledAfter = Date.now() - t2;
      await locker.query('ROLLBACK');
      const t3 = Date.now(); let present = 1;
      while (Date.now() - t3 < 1000 && present > 0) { present = (await locker.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1`, [backend])).rows[0].n; if (present) await new Promise(r => setTimeout(r, 25)); }
      assert.equal(present, 0, 'the backend is gone once the external lock is released');
      console.log(`# REVAL_EVIDENCE native physical stall: DeadlineExceeded after ${ms.toFixed(0)} ms (budget 800); statement cancelled ≤${cancelledAfter} ms later with the lock held; backend gone ${Date.now() - t3} ms after release`);
    } finally { await locker.query('ROLLBACK').catch(() => undefined); await locker.end(); }
    assert.ok(await waitGone([], 1));
  } finally { await owner.end().catch(() => undefined); }
});
