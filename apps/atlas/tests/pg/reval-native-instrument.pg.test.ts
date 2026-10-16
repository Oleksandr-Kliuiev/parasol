import { verifyTestRevision } from '../support/reval-history.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { assertReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { PRISMA_CLI, runWithDatabase } from '../support/pg-harness.ts';
import { PRICE, revise } from '../support/ask-remote-pg.ts';
import { LiveOwner } from '../support/reval-eval-process.ts';
import { LiveTty } from '../support/reval-live-tty.ts';
import { askPath, browserHeaders, handoffPath, post } from '../support/reval-eval-server.ts';
import { ACTOR, CLIENT, WS, provisionSandbox } from '../support/reval-fixture-pg.ts';
import { dropRolesSql, readRolesSql, renderRolesSql, revalRoleNames, uniqueRoleNames } from '../support/roles-sql.ts';
import { privateDir, writeOwnerConfig } from '../support/reval-test-deps.ts';

// R-EVAL RS-C-B native Unix PG17 server chain (instrument artifact input is the verified historical test fixture) (rs-c brief B §7): with ATLAS_REVAL_NATIVE_PG_FIXTURE set, production
// maintenance installs FX07 (the first frozen case's fixture); the production owner CLI (live PTY) → production controller → the
// BUILT production bridge server (no-key seams) and the REAL instrument revision CLI (live PTY) run the first case: GO → the
// browser's question → 503 ASK_REMOTE_UNAVAILABLE (never dispatched) → measured handoff of that ERROR → COMMITTED → finish → v4 (RS-D-A:
// production guard census MATCH, no capability consumption).
const fixturePath = process.env.ATLAS_REVAL_NATIVE_PG_FIXTURE;
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = !fixturePath ? 'NATIVE_UNIX_PG_FIXTURE_ABSENT' : !darwin ? 'darwin/arm64 only' : false;
interface Native { socketDir: string; port: number; dataDirectory: string; adminRole: string; adminSecretFile: string }
const fx: Native | null = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
const connect = async (user: string, password: string, database: string) => { const c = new pg.Client({ host: fx!.socketDir, port: fx!.port, user, password, database }); await c.connect(); return c; };
const maintain = (config: string, ...args: string[]) => JSON.parse(spawnSync(process.execPath, [`${PROJECT_ROOT}/scripts/reval-server/maintain.ts`, '--config', config, ...args],
  { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim()) as Record<string, unknown>;
const ctx = bindCorpus(verifyTestRevision().snapshot);
const CASE = 'RE-UNS-051'; const question = ctx.corpus.cases.get(CASE)!.question;

test('native production chain + instrument revision: GO → no-key ERROR → measured handoff COMMITTED → finish → receipt v6', { skip, timeout: 600000 }, async () => {
  const adminPw = readFileSync(fx!.adminSecretFile, 'utf8').trim();
  const admin = await connect(fx!.adminRole, adminPw, 'postgres');
  const suffix = randomBytes(4).toString('hex');
  const ownerRole = `atlas_rv_rscb_${suffix}`; const ownerPw = randomBytes(18).toString('hex'); const dbName = `atlas_rv_rscb_${suffix}`;
  const roles = uniqueRoleNames('nrcb', suffix);
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), poRunnerPassword: randomBytes(18).toString('hex'),
    revalReaderPassword: randomBytes(18).toString('hex') };
  let o: LiveOwner | null = null; let i: LiveTty | null = null; let owner: pg.Client | null = null;
  after(async () => {
    if (i) assert.deepEqual((await i.stop()).forced, []);
    if (o) assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives');
    await owner?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    for (const q of dropRolesSql(roles)) await admin.query(q).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPw}'`);
  const boot = await connect(ownerRole, ownerPw, 'postgres'); await boot.query(`CREATE DATABASE "${dbName}"`); await boot.end();
  runWithDatabase(`postgresql://${ownerRole}:${ownerPw}@localhost:${fx!.port}/${dbName}?host=${encodeURIComponent(fx!.socketDir)}`, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  const setup = await connect(ownerRole, ownerPw, dbName);
  await setup.query(renderRolesSql(await readRolesSql(), roles, secrets));
  const { admissionId } = await provisionSandbox(setup);
  const facts = (await setup.query(`SELECT (pg_control_system()).system_identifier::text AS s, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS o`)).rows[0];
  await setup.end();
  const sock = statSync(`${fx!.socketDir}/.s.PGSQL.${fx!.port}`); const pidf = readFileSync(`${fx!.dataDirectory}/postmaster.pid`, 'utf8').split('\n');
  const physical = { systemIdentifier: facts.s, databaseOid: facts.o, postmasterStartTime: pidf[2]!, postmasterPid: pidf[0]!, dataDirectory: fx!.dataDirectory,
    socketDevice: String(sock.dev), socketInode: String(sock.ino) };
  const helper = buildPeer(`${await privateDir('native-rscb')}/peer`);
  const ids = { registrationId: randomUUID(), databaseInstanceId: randomUUID() };
  const serverPort = 5200 + Math.floor(Math.random() * 300);
  const config = (await writeOwnerConfig(await privateDir('nrscb'), { contractVersion: 'RevalOwnerConfigV1', ...ids, workspaceId: WS, clientId: CLIENT, actorId: ACTOR,
    admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: fx!.socketDir, port: fx!.port, database: dbName }, roles: { reader: revalRoleNames(roles).reader, runtime: roles.runtime, owner: ownerRole },
    physical, server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: secrets.revalReaderPassword, runtime: secrets.runtimePassword, owner: ownerPw })).path;
  const dir = dirname(config);
  assert.deepEqual(maintain(config, 'register'), { ok: true, ...ids });
  assert.equal(maintain(config, 'install', 'FX07', '0').ok, true);
  owner = await connect(ownerRole, ownerPw, dbName);
  const bearer = generateToken();
  await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-native-b', $2, $3)`, [WS, ACTOR, hashToken(bearer)]);
  const fence = (await owner.query(`SELECT version::text AS v FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WS])).rows[0].v as string;
  await owner.query('COMMIT');

  o = new LiveOwner(dir, `${PROJECT_ROOT}/scripts/reval-server/owner.ts`, ['--config', config]);
  await o.prompt();
  assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
  assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"allFiveIntents":true/);
  const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
  const receipts = join(dir, 'receipts'); mkdirSync(receipts, { mode: 0o700 });
  i = new LiveTty(dir, `${PROJECT_ROOT}/tests/support/reval-instrument-cli.ts`, ['session', '--owner-config', config, '--receipt-dir', receipts], 'instrument');
  await i.expect(/ARTIFACT VERIFIED/, 30000);
  i.type('connect');
  const [, ctl, ho] = await i.expect(/CONNECTED ([0-9a-f-]{36}) ([0-9a-f-]{36})/);
  const [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
  const pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
  const p = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: secretLine!.split(' ')[2] }), browserHeaders(serverPort, bearer));
  assert.equal(p.status, 200, p.body);
  const session = JSON.parse(p.body).sessionToken as string;
  const now = Date.now();
  i.type('admission');
  for (const v of [admissionId, new Date(now - 60_000).toISOString(), new Date(now + 2 * 3_600_000).toISOString(), '2000000', '10000000', fence, '10']) i.type(v);
  await i.expect(/ADMISSION_RECORDED_ATTESTED_SNAPSHOT_CROSSCHECKED/);
  i.type('pair-ack'); i.type(ackLine!.slice('OK PAIR_ACK '.length)); await i.expect(/PAIR_RECORDED/);
  i.type('confirm'); i.type(admissionId); i.type(policyVersion); await i.expect(/\nCONFIRMED/);
  const cap = await post(serverPort, '/ask/capabilities', null, { host: `127.0.0.1:${serverPort}`, authorization: `Bearer ${bearer}` }, 'GET');
  i.type('capability'); i.type('200'); i.type(String(cap.headers['x-atlas-correlation-id'])); i.paste(cap.body); await i.expect(/\nOK\r?\n/);
  i.type('stage'); i.type('none'); i.paste(question); await i.expect(/\nSTAGED/);
  i.type('consent'); const [, nonce] = await i.expect(/challenge for RE-UNS-051: ([0-9a-f]+)/); i.type(nonce!); i.type('YES'); await i.expect(/\nCONSENTED/);
  i.type('go'); await i.expect(/GO_CLICK_ASK_NOW RE-UNS-051 \d+/);
  const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question, observationId: null,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion, questionDataClass: 'SYNTHETIC' } };
  const q = await post(serverPort, askPath, JSON.stringify(body), browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': session }));
  assert.deepEqual([q.status, JSON.parse(q.body).code], [503, 'ASK_REMOTE_UNAVAILABLE'], 'the production bridge seams never resolve a key');
  const h = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId, receiptNonce: q.headers['x-atlas-evaluation-receipt'],
    request: body, response: { status: 503, correlationId: q.headers['x-atlas-correlation-id'], body: JSON.parse(q.body) } }), browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': session }));
  assert.equal(h.status, 204, h.body);
  i.type('finish');
  const [, state] = await i.expect(/CASE_RECORDED RE-UNS-051 (\S+) COMMITTED/, 30000);
  i.type('quit'); await i.expect(/\[quit\]/);
  const rec = JSON.parse(readFileSync(join(receipts, readdirSync(receipts).find(f => f.startsWith('REVAL_INSTRUMENT_') && f.endsWith('.json'))!), 'utf8'));
  assertReceiptV6(rec, ctx.cases);
  const c = rec.cases[CASE]; const record = rec.base.cases.find((x: { caseId: string }) => x.caseId === CASE);
  assert.deepEqual([c.handoff.result.publicOutcome, c.handoff.result.publicErrorCode, c.ledgerSource, record.ledgerSettlement, record.chargedMicro],
    ['ERROR', 'ASK_REMOTE_UNAVAILABLE', 'CONTROLLER_POST_SNAPSHOT', 'NO_DISPATCH', 0]);
  // RS-D-A: the production census of the production chain — one submission and reservation, NO capability consumption/transport entry.
  const d = (k: string) => BigInt(c.postCensus[k]) - BigInt(c.preCensus[k]);
  assert.deepEqual([c.census, ...['submitIngressCount', 'reservationConfirmedCount', 'capabilityConsumedCount', 'transportEntryCount', 'publicationCount'].map(d)],
    ['MATCH', 1n, 1n, 0n, 0n, 1n]);
  console.log(`# REVAL_EVIDENCE native RS-C-B: production chain + instrument → ${state}, outcome ${record.outcome}, settlement ${record.ledgerSettlement}, charged ${record.chargedMicro}`);
});
