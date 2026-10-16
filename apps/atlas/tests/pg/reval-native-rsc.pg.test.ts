import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { loadCaseFixtures } from '../../packages/reval/eval-cases.ts';
import { decodeTransfer } from '../../packages/reval/eval-transient.ts';
import { decodeArmAck, decodePairAck, decodeTerminalObservation } from '../../packages/reval/eval-wire.ts';
import { PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRISMA_CLI, runWithDatabase } from '../support/pg-harness.ts';
import { PRICE, revise } from '../support/ask-remote-pg.ts';
import { errorResult } from '../support/reval-eval-fixtures.ts';
import { instrument, LiveOwner } from '../support/reval-eval-process.ts';
import type { InstrumentProcess } from '../support/reval-eval-process.ts';
import { askPath, browserHeaders, handoffPath, post } from '../support/reval-eval-server.ts';
import { ACTOR, CLIENT, WS, provisionSandbox } from '../support/reval-fixture-pg.ts';
import { dropRolesSql, readRolesSql, renderRolesSql, revalRoleNames, uniqueRoleNames } from '../support/roles-sql.ts';
import { privateDir, writeOwnerConfig } from '../support/reval-test-deps.ts';

// R-EVAL RS-C-A native Unix PG17 PRODUCTION CHAIN (rs-c/IMPLEMENTATION_BRIEF.md §1–§5): with ATLAS_REVAL_NATIVE_PG_FIXTURE set,
// the production maintenance entry registers and installs FX02; then the production owner CLI (live PTY) → production controller
// → the BUILT production server `dist/apps/api/src/main.js` (unix-socket physical binding, RS-C-A composition, NO test seam:
// bridge mode composes the no-key seams of rc2 F1, so the call is never dispatched — independent of S's environment, whose
// Prisma dotenv loading can add checkout `.env` names; the sandbox policy here also names a `fixture://` reference, which the
// production resolver never resolves anyway: the regression for F1 itself is the in-process `env://` test in
// reval-eval-server.pg.test.ts) with the test instrument (real PTY, actual pinned-helper peer proofs on both sockets) and the
// browser. Test-fixture evidence only: never MEASURED.
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
  return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
};

test('native production chain: PAIR → ARM → READY → question (bridge no-key seams: never dispatched) → handoff COMMIT → journaled final observation', { skip, timeout: 600000 }, async () => {
  const adminPw = readFileSync(fx!.adminSecretFile, 'utf8').trim();
  const admin = await connect(fx!.adminRole, adminPw, 'postgres');
  const suffix = randomBytes(4).toString('hex');
  const ownerRole = `atlas_rv_rsc_${suffix}`; const ownerPw = randomBytes(18).toString('hex'); const dbName = `atlas_rv_rsc_${suffix}`;
  const roles = uniqueRoleNames('nrc', suffix);
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), poRunnerPassword: randomBytes(18).toString('hex'),
    revalReaderPassword: randomBytes(18).toString('hex') };
  let o: LiveOwner | null = null; let inst: InstrumentProcess | null = null; let owner: pg.Client | null = null;
  after(async () => {
    await inst?.stop();
    if (o) assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives');
    await owner?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    for (const q of dropRolesSql(roles)) await admin.query(q).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });
  console.log(`# REVAL_EVIDENCE native fixture descriptor sha256=${createHash('sha256').update(readFileSync(fixturePath!)).digest('hex')}`);
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPw}'`);
  const boot = await connect(ownerRole, ownerPw, 'postgres'); await boot.query(`CREATE DATABASE "${dbName}"`); await boot.end();
  runWithDatabase(`postgresql://${ownerRole}:${ownerPw}@localhost:${fx!.port}/${dbName}?host=${encodeURIComponent(fx!.socketDir)}`, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  const setup = await connect(ownerRole, ownerPw, dbName);
  await setup.query(renderRolesSql(await readRolesSql(), roles, secrets));
  const { admissionId } = await provisionSandbox(setup);
  const facts = (await setup.query(`SELECT (pg_control_system()).system_identifier::text AS s, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS o`)).rows[0];
  await setup.end();
  const sock = statSync(`${fx!.socketDir}/.s.PGSQL.${fx!.port}`);
  const pid = readFileSync(`${fx!.dataDirectory}/postmaster.pid`, 'utf8').split('\n');
  const physical = { systemIdentifier: facts.s, databaseOid: facts.o, postmasterStartTime: pid[2]!, postmasterPid: pid[0]!, dataDirectory: fx!.dataDirectory,
    socketDevice: String(sock.dev), socketInode: String(sock.ino) };
  const helper = buildPeer(`${await privateDir('native-rsc')}/peer`);
  const ids = { registrationId: randomUUID(), databaseInstanceId: randomUUID() };
  const serverPort = 4600 + Math.floor(Math.random() * 300);
  const config = (await writeOwnerConfig(await privateDir('nrsc-ok'), { contractVersion: 'RevalOwnerConfigV1', ...ids, workspaceId: WS, clientId: CLIENT, actorId: ACTOR,
    admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: fx!.socketDir, port: fx!.port, database: dbName }, roles: { reader: revalRoleNames(roles).reader, runtime: roles.runtime, owner: ownerRole },
    physical, server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: secrets.revalReaderPassword, runtime: secrets.runtimePassword, owner: ownerPw })).path;
  const dir = dirname(config);
  assert.deepEqual(maintain(config, 'register'), { ok: true, ...ids });
  assert.equal(maintain(config, 'install', 'FX02', '0').ok, true);
  owner = await connect(ownerRole, ownerPw, dbName);
  const bearer = generateToken();
  await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-native', $2, $3)`, [WS, ACTOR, hashToken(bearer)]); await owner.query('COMMIT');

  o = new LiveOwner(dir, `${PROJECT_ROOT}/scripts/reval-server/owner.ts`, ['--config', config]);
  await o.prompt();
  assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
  assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"allFiveIntents":true/);
  const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
  const i = await instrument(dir, ids); inst = i.inst;
  const [ackLine, secretLine] = await o.type(`pair ${i.controlId} ${i.handoffId}`, 2);
  const pairAck = decodePairAck(JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)));
  const nonce = secretLine!.split(' ')[2]!;
  const p = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce }), browserHeaders(serverPort, bearer));
  assert.equal(p.status, 200, p.body);
  const session = JSON.parse(p.body).sessionToken as string;
  const pre = await i.request('SNAPSHOT', {});
  const caseId = [...loadCaseFixtures()].find(([, f]) => f === 'FX02')![0];
  const arm = await i.request('ARM_CASE', { caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId, policyVersion, preSnapshotId: pre.payload.snapshotId,
    browserPairId: pairAck.pairId });
  assert.deepEqual([arm.kind, arm.emitter], ['ARM_ACK', 'SERVER'], JSON.stringify(arm.payload));
  const ack = decodeArmAck(arm.payload);
  await i.handoff({ contractVersion: 'RevalTransientReadyV1', registrationId: ids.registrationId, serverBootId: i.serverBootId, challenge: randomUUID(),
    pairId: pairAck.pairId, armId: ack.armId, caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId, policyVersion, preSnapshotId: ack.preSnapshotId });
  assert.equal((await i.inst.next('ho')).disposition, 'READY');
  const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question: 'What needs attention for this client right now?', observationId: 'syn-obs-b2',
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion, questionDataClass: 'SYNTHETIC' } };
  const q = await post(serverPort, askPath, JSON.stringify(body), browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': session }));
  const qb = JSON.parse(q.body);
  assert.equal(q.status, 503, q.body);
  const code = qb.code as string;
  console.log(`# REVAL_EVIDENCE native RS-C-A: production bridge S (no-key seams) → ${q.status} ${code} (never dispatched)`);
  const handoff = post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: pairAck.pairId,
    receiptNonce: q.headers['x-atlas-evaluation-receipt'], request: body, response: { status: q.status, correlationId: q.headers['x-atlas-correlation-id'], body: qb } }),
  browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': session }));
  const t = decodeTransfer(await i.inst.next('ho'));
  assert.equal(t.publicationAuthority, 'NOT_APPLICABLE');
  await i.handoff({ contractVersion: 'RevalTransientAckV1', challenge: t.ackChallenge, transferSequence: t.sequence, transferId: t.transferId, binding: t.binding,
    commitChallenge: randomUUID(), disposition: 'ACCEPTED', result: errorResult(code), failureCode: null });
  assert.equal((await i.inst.next('ho')).disposition, 'COMMITTED');
  assert.equal((await handoff).status, 204);
  let obs: any = null;
  for (let k = 0; k < 40 && !(obs && obs.final); k += 1) {
    obs = decodeTerminalObservation((await i.request('TERMINAL_OBSERVATION', { armId: ack.armId })).payload);
    if (!obs.final) await new Promise(res => setTimeout(res, 50));
  }
  assert.ok(obs.final);
  assert.deepEqual(obs.publication, { state: 'SERVER_FINISHED', kind: 'ERROR', status: 503, code });
  await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
  const attempts = (await owner.query(`SELECT outcome, "accountedMicroUsd"::text AS a FROM "RemoteAskAttempt" WHERE "workspaceId" = $1`, [WS])).rows;
  await owner.query('COMMIT');
  for (const a of attempts) assert.equal(a.a, '0', 'nothing charged');
  const journal = readFileSync(join(dir, 'reval-journal.jsonl'), 'utf8');
  assert.deepEqual(JSON.parse(journal.trim().split('\n').at(-1)!).record, obs);
  for (const s of [nonce, session, bearer, body.question]) assert.ok(!journal.includes(s), 'no secret or raw value in the journal');
  for (const s of [session, bearer, secrets.runtimePassword, ownerPw]) assert.ok(!o.transcript.includes(s), 'no credential in the owner transcript');
  console.log(`# REVAL_EVIDENCE native RS-C-A: PAIR/ARM/READY/handoff COMMIT/final observation journaled; attempts ${JSON.stringify(attempts.map(a => a.outcome))}`);
});
