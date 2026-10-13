import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import pg from 'pg';
import { DATASET_MANIFEST_SHA256, SEED_MAPPING_SHA256 } from '../../packages/reval/dataset.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { decodeFixtureCheck } from '../../packages/reval/payloads.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRISMA_CLI, runWithDatabase } from '../support/pg-harness.ts';
import { PRICE } from '../support/ask-remote-pg.ts';
import { ACTOR, CLIENT, WS, provisionSandbox } from '../support/reval-fixture-pg.ts';
import { dropRolesSql, readRolesSql, renderRolesSql, revalRoleNames, uniqueRoleNames } from '../support/roles-sql.ts';
import { NODE_REALPATH, privateDir, writeOwnerConfig } from '../support/reval-test-deps.ts';
import { PtySession } from '../support/reval-pty.ts';

// R-EVAL RS-B native Unix PG17 PRODUCTION CHAIN (rs-b brief §1, B5–B9): with ATLAS_REVAL_NATIVE_PG_FIXTURE set, the unmodified
// production maintenance entry `scripts/reval-server/maintain.ts` (separate processes, unix-socket physical binding of both
// owner connections, no test DI) probes, registers and switches fixtures; then the production owner CLI under a real PTY →
// production controller → production `scripts/reval-server/fixture-verifier.ts` (runtime role, actual peer proof) answers
// FIXTURE_CHECK. A dedicated NOSUPERUSER NOBYPASSRLS owner owns everything; the fixture admin only bootstraps. Test-fixture
// evidence only: never MEASURED and never platform/image proof. Without the descriptor it skips NATIVE_UNIX_PG_FIXTURE_ABSENT.
const fixturePath = process.env.ATLAS_REVAL_NATIVE_PG_FIXTURE;
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = !fixturePath ? 'NATIVE_UNIX_PG_FIXTURE_ABSENT' : !darwin ? 'darwin/arm64 only' : false;
interface Native { socketDir: string; port: number; dataDirectory: string; adminRole: string; adminSecretFile: string }
const fx: Native | null = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
const connect = async (user: string, password: string, database: string) => {
  const c = new pg.Client({ host: fx!.socketDir, port: fx!.port, user, password, database }); await c.connect(); return c;
};
const maintain = (config: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [`${PROJECT_ROOT}/scripts/reval-server/maintain.ts`, '--config', config, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { status: r.status, json: JSON.parse(r.stdout.trim()) as Record<string, unknown>, stderr: r.stderr };
};

test('native production chain: maintain probe/register/install over the unix socket, then FIXTURE_CHECK via O → C → V', { skip, timeout: 600000 }, async () => {
  const adminPw = readFileSync(fx!.adminSecretFile, 'utf8').trim();
  const admin = await connect(fx!.adminRole, adminPw, 'postgres');
  const suffix = randomBytes(4).toString('hex');
  const ownerRole = `atlas_rv_rsb_${suffix}`; const ownerPw = randomBytes(18).toString('hex'); const dbName = `atlas_rv_rsb_${suffix}`;
  const roles = uniqueRoleNames('nrb', suffix);
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), poRunnerPassword: randomBytes(18).toString('hex'),
    revalReaderPassword: randomBytes(18).toString('hex') };
  const sessions: PtySession[] = [];
  after(async () => {
    for (const s of sessions) assert.deepEqual((await s.stop()).forced, [], 'no O/C/V process survives');
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    for (const q of dropRolesSql(roles)) await admin.query(q).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });
  console.log(`# REVAL_EVIDENCE native fixture descriptor sha256=${createHash('sha256').update(readFileSync(fixturePath!)).digest('hex')}`);
  console.log(`# REVAL_EVIDENCE native server ${(await admin.query('SHOW server_version')).rows[0].server_version}`);
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPw}'`);
  const boot = await connect(ownerRole, ownerPw, 'postgres'); await boot.query(`CREATE DATABASE "${dbName}"`); await boot.end();
  runWithDatabase(`postgresql://${ownerRole}:${ownerPw}@localhost:${fx!.port}/${dbName}?host=${encodeURIComponent(fx!.socketDir)}`, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  const owner = await connect(ownerRole, ownerPw, dbName);
  await owner.query(renderRolesSql(await readRolesSql(), roles, secrets));
  const { admissionId } = await provisionSandbox(owner);
  const facts = (await owner.query(`SELECT (pg_control_system()).system_identifier::text AS s, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS o`)).rows[0];
  await owner.end(); // from here on, only the tool's own two connections may exist on the sandbox
  const sock = statSync(`${fx!.socketDir}/.s.PGSQL.${fx!.port}`);
  const pid = readFileSync(`${fx!.dataDirectory}/postmaster.pid`, 'utf8').split('\n');
  const physical = { systemIdentifier: facts.s, databaseOid: facts.o, postmasterStartTime: pid[2]!, postmasterPid: pid[0]!, dataDirectory: fx!.dataDirectory,
    socketDevice: String(sock.dev), socketInode: String(sock.ino) };
  const work = await privateDir('native-rsb');
  const helper = buildPeer(`${work}/peer`);
  const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
  const ids = { registrationId: randomUUID(), databaseInstanceId: randomUUID() };
  const configFor = async (label: string, phys: typeof physical) => (await writeOwnerConfig(await privateDir(`nrsb-${label}`), { contractVersion: 'RevalOwnerConfigV1',
    ...ids, workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path,
    nativePeerHelperSha256: helper.sha256, endpoint: { socketDir: fx!.socketDir, port: fx!.port, database: dbName },
    roles: { reader: revalRoleNames(roles).reader, runtime: roles.runtime, owner: ownerRole }, physical: phys,
    server: { mode: 'NONE', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: 4999 } } as never,
  { reader: secrets.revalReaderPassword, runtime: secrets.runtimePassword, owner: ownerPw })).path;
  // probe: the owner learns the tuple from the configured data directory and socket (placeholders elsewhere).
  const draft = await configFor('draft', { ...physical, systemIdentifier: '0', databaseOid: '0', postmasterStartTime: '0', postmasterPid: '1', socketDevice: '0', socketInode: '0' });
  const probe = maintain(draft, 'probe');
  assert.equal(probe.status, 0, probe.stderr.slice(-400)); assert.deepEqual(probe.json, { ok: true, physical });
  const config = await configFor('ok', physical);
  const wrong = await configFor('inode', { ...physical, socketInode: String(sock.ino + 1) });
  assert.deepEqual(maintain(wrong, 'register').json, { ok: false, code: 'REGISTRATION_MISMATCH' }, 'a copied tuple with another socket inode refuses');
  assert.deepEqual(maintain(config, 'register').json, { ok: true, ...ids });
  const fx02 = maintain(config, 'install', 'FX02', '0');
  assert.deepEqual(fx02.json, { ok: true, fixtureId: 'FX02', generation: '1', seedMappingSha256: SEED_MAPPING_SHA256, fenceAdvanced: true });
  assert.deepEqual(maintain(config, 'install', 'FX04', '1').json, { ok: true, fixtureId: 'FX04', generation: '2', seedMappingSha256: SEED_MAPPING_SHA256, fenceAdvanced: true });
  assert.deepEqual(maintain(config, 'install', 'FX08', '2').json, { ok: true, fixtureId: 'FX08', generation: '3', seedMappingSha256: SEED_MAPPING_SHA256, fenceAdvanced: true });
  const backends = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [dbName])).rows[0].n;
  assert.equal(backends, 0, 'the tool leaves no backend');
  // FIXTURE_CHECK through the production owner CLI, controller and verifier (unix socket, actual peer proof).
  const s = new PtySession(await privateDir('nrsb-pty'), `${PROJECT_ROOT}/scripts/reval-server/owner.ts`, ['--config', config], ['snapshot', 'fixture-check', 'quit']);
  sessions.push(s);
  assert.ok(await s.exited(120000), 'session ended');
  const r = s.results.map(x => x.line);
  assert.match(r[0]!, /^OK SNAPSHOT /, r.join(' | '));
  assert.match(r[1]!, /^OK FIXTURE_CHECK /, r.join(' | '));
  assert.deepEqual(decodeFixtureCheck(JSON.parse(r[1]!.slice(r[1]!.indexOf('{')))), { fixtureId: 'FX08', fixtureGeneration: '3', datasetManifestSha256: DATASET_MANIFEST_SHA256,
    seedMappingSha256: SEED_MAPPING_SHA256, syntheticFreshnessAt: '2026-10-10T07:30:00.000Z', sourceMode: 'db', rowIdentity: true, sourceProjection: true,
    expectedFacts: true, allFiveIntents: true, financeUnchanged: true, realTimeFreshnessClaim: false });
  console.log(`# REVAL_EVIDENCE native RS-B: probe tuple equal, register, FX02→FX04 (mapping exception)→FX08, FIXTURE_CHECK all true in ${(s.results[1]!.at - s.results[0]!.at).toFixed(0)} ms; buildManifest ${digests.buildManifestSha256.slice(0, 12)}`);
  for (const pw of [secrets.runtimePassword, secrets.revalReaderPassword, ownerPw, adminPw]) assert.ok(!s.transcript.includes(pw), 'no credential in the transcript');
});
