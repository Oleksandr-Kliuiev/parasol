import { verifyTestRevision } from '../support/reval-history.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { assertReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { fenceOf, PRICE, revise } from '../support/ask-remote-pg.ts';
import { LiveOwner } from '../support/reval-eval-process.ts';
import { LiveTty } from '../support/reval-live-tty.ts';
import { askPath, browserHeaders, handoffPath, post } from '../support/reval-eval-server.ts';
import { ACTOR, CLIENT, WS, install, ownerTx, pidOf, provisionSandbox, q, registration } from '../support/reval-fixture-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-C-B process E2E on darwin/arm64 + Docker PG17 (rs-c brief B §7): the REAL instrument revision CLI under a live PTY
// drives the unchanged RC5 ExecutionSession with measured inputs against O (live PTY) → C → S (BUILT bridge server, scripted
// OFFLINE provider) and the browser (raw HTTP). The first frozen case (RE-UNS-051, FX07) runs through GO → answer → handoff
// COMMITTED → finish → receipt v4 (RS-D-A: PRE/POST process census MATCH); a second session shows a PRE failure BEFORE consumption and an
// ARM failure AFTER it.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only' };
// Identity and corpus FIRST: a top-level failure must happen before any throwaway database exists.
const ctx = bindCorpus(verifyTestRevision().snapshot);
const CASE = 'RE-UNS-051'; const question = ctx.corpus.cases.get(CASE)!.question;
const ns = await nonsuperDatabase();
const { db } = ns; const owner = db.owner;
after(async () => { await ns.cleanup(); });
const physical = await dockerPhysical(ns.admin);
await ns.admin.end();
const helper = buildPeer(`${await privateDir('rscb-e2e')}/peer`);
const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole, digests.buildManifestSha256);
const pid = await pidOf(owner);
await registerSandbox(q(owner), r, [pid]);
await install(owner, r, 'FX07', '0', [pid]);
const bearer = generateToken();
await ownerTx(owner, () => owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-rscb', $2, $3)`, [WS, ACTOR, hashToken(bearer)]));
const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
const ownerEntry = fileURLToPath(new URL('../support/reval-test-owner-entry.ts', import.meta.url));
const cli = fileURLToPath(new URL('../support/reval-instrument-cli.ts', import.meta.url));
let n = 0; let port = 4900 + Math.floor(Math.random() * 300);

async function session() {
  await revise(owner, WS, { state: 'PAUSED' });
  const dir = await privateDir(`rscb${++n}`); const serverPort = ++port;
  const { path } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId,
    workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name }, roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole },
    physical, server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
  await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, provider: { intent: 'UNSUPPORTED' } }));
  const o = new LiveOwner(dir, ownerEntry, ['--config', path]);
  await o.prompt();
  assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
  assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"allFiveIntents":true/);
  const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
  const receipts = join(dir, 'receipts'); mkdirSync(receipts, { mode: 0o700 });
  const i = new LiveTty(dir, cli, ['session', '--owner-config', path, '--receipt-dir', receipts], 'instrument');
  await i.expect(/ARTIFACT VERIFIED/, 30000);
  i.type('connect');
  const [, ctl, ho] = await i.expect(/CONNECTED ([0-9a-f-]{36}) ([0-9a-f-]{36})/);
  const [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
  const pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
  const p = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: secretLine!.split(' ')[2] }),
    browserHeaders(serverPort, bearer));
  assert.equal(p.status, 200, p.body);
  const sessionToken = JSON.parse(p.body).sessionToken as string;
  const now = Date.now();
  i.type('admission');
  for (const v of [admissionId, new Date(now - 60_000).toISOString(), new Date(now + 2 * 3_600_000).toISOString(), '2000000', '10000000', String(await fenceOf(owner, WS)), '10']) i.type(v);
  await i.expect(/ADMISSION_RECORDED_ATTESTED_SNAPSHOT_CROSSCHECKED/);
  return { dir, o, i, serverPort, pairId, ack: ackLine!.slice('OK PAIR_ACK '.length), sessionToken, policyVersion, receipts };
}
type S = Awaited<ReturnType<typeof session>>;
async function prepare(s: S, policyVersion: string) {
  s.i.type('confirm'); s.i.type(admissionId); s.i.type(policyVersion); await s.i.expect(/\nCONFIRMED/);
  const cap = await post(s.serverPort, '/ask/capabilities', null, { host: `127.0.0.1:${s.serverPort}`, authorization: `Bearer ${bearer}` }, 'GET');
  assert.equal(cap.status, 200, cap.body);
  s.i.type('capability'); s.i.type('200'); s.i.type(String(cap.headers['x-atlas-correlation-id'])); s.i.paste(cap.body); await s.i.expect(/\nOK\r?\n/);
  s.i.type('stage'); s.i.type('none'); s.i.paste(question); await s.i.expect(/\nSTAGED/);
  s.i.type('consent');
  const [, nonce] = await s.i.expect(/challenge for RE-UNS-051: ([0-9a-f]+)/);
  s.i.type(nonce!); s.i.type('YES'); await s.i.expect(/\nCONSENTED/);
}
const receiptOf = (s: S) => JSON.parse(readFileSync(join(s.receipts, readdirSync(s.receipts).find(f => f.startsWith('REVAL_INSTRUMENT_') && f.endsWith('.json'))!), 'utf8'));

test('instrument revision: GO (PRE census → PRE → consume → ARM → READY) → answer → handoff COMMITTED → finish (POST census) → receipt v4', skip, async () => {
  const s = await session();
  try {
    s.i.type('pair-ack'); s.i.type(s.ack); await s.i.expect(/PAIR_RECORDED/);
    await prepare(s, s.policyVersion);
    s.i.type('go');
    const [, seconds] = await s.i.expect(/GO_CLICK_ASK_NOW RE-UNS-051 (\d+)/);
    assert.ok(Number(seconds) > 0 && Number(seconds) <= 30);
    const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question, observationId: null,
      acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion: s.policyVersion, questionDataClass: 'SYNTHETIC' } };
    const qres = await post(s.serverPort, askPath, JSON.stringify(body), browserHeaders(s.serverPort, bearer, { 'x-atlas-evaluation-session': s.sessionToken }));
    assert.equal(qres.status, 200, qres.body);
    const h = await post(s.serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: s.pairId,
      receiptNonce: qres.headers['x-atlas-evaluation-receipt'], request: body, response: { status: 200, correlationId: qres.headers['x-atlas-correlation-id'], body: JSON.parse(qres.body) } }),
    browserHeaders(s.serverPort, bearer, { 'x-atlas-evaluation-session': s.sessionToken }));
    assert.equal(h.status, 204, h.body);
    s.i.type('finish');
    const [, state] = await s.i.expect(/CASE_RECORDED RE-UNS-051 (\S+) COMMITTED/, 30000);
    s.i.type('quit'); await s.i.expect(/\[quit\]/);
    const rec = receiptOf(s);
    assertReceiptV6(rec, ctx.cases);
    const c = rec.cases[CASE];
    assert.deepEqual([c.handoffState, c.handoff.state, c.terminal.final, c.ledgerSource, c.armFailure], ['COMMITTED', 'COMMITTED', true, 'CONTROLLER_POST_SNAPSHOT', null]);
    assert.deepEqual([c.armIssued, c.abandonedByOperator, c.creditBlock, c.terminal.detectedFault], [true, false, null, 'NONE'], 'FINAL authenticated record agrees with the handoff');
    // RS-D-A: S's guard census around the case — one submission, one reservation, one (scripted offline) dispatch, one publication.
    const d = (k: string) => BigInt(c.postCensus[k]) - BigInt(c.preCensus[k]);
    assert.deepEqual([c.census, c.censusReason, c.preCensus.guardEpoch === c.postCensus.guardEpoch], ['MATCH', null, true]);
    assert.deepEqual(['submitIngressCount', 'reservationConfirmedCount', 'capabilityConsumedCount', 'transportEntryCount', 'publicationCount', 'physicalReleaseCount',
      'handoffIngressCount', 'rejectedUnpairedCount', 'unattributedCount'].map(d), [1n, 1n, 1n, 1n, 1n, 1n, 1n, 0n, 0n]);
    assert.deepEqual([rec.order.rule, rec.order.frozenOrderSha256 === rec.base.artifact.orderSha256, rec.drains], ['FIXTURE_GROUPED_FIRST_APPEARANCE_V1', true, []]);
    assert.deepEqual(rec.effective, { state: rec.base.run.state, reason: null });
    assert.deepEqual([rec.flags.verifiedPass, rec.base.verifiedPass ?? false, rec.armStop], [false, false, null]);
    const record = rec.base.cases.find((x: { caseId: string }) => x.caseId === CASE);
    console.log(`# REVAL_EVIDENCE RS-C-B case ${CASE}: run ${state}, outcome ${record.outcome}, casePass ${record.casePass}, ARM ${c.armMs} ms, READY ${c.readyMs} ms`);
    for (const secret of [question, s.sessionToken, bearer, String(qres.headers['x-atlas-evaluation-receipt'])]) assert.ok(!JSON.stringify(rec).includes(secret), 'no raw value or secret');
    assert.ok(!s.i.transcript.includes(question.slice(0, 40)), 'the pasted question is never echoed (raw mode for the whole session)');
  } finally {
    assert.deepEqual((await s.i.stop()).forced, []); assert.deepEqual((await s.o.stop()).forced, [], 'no O/C/S process survives');
  }
});

test('GO failures: a PRE tuple change refuses BEFORE consumption (case still next); an ARM failure AFTER consumption abandons it and stops arming', skip, async () => {
  const s = await session();
  try {
    s.i.type('pair-ack'); s.i.type(JSON.stringify({ pairId: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString(), paired: false }));
    await s.i.expect(/PAIR_RECORDED/); // not the owner's pair: C refuses the ARM after consumption
    await prepare(s, s.policyVersion);
    await revise(owner, WS, { state: 'PAUSED' });
    const bumped = await revise(owner, WS, { state: 'ACTIVE' }); // a newer ACTIVE version: the confirmed tuple is stale
    s.i.type('go'); await s.i.expect(/BLOCKED_PRE_TUPLE DO_NOT_CLICK/);
    s.i.type('status'); await s.i.expect(/NEXT RE-UNS-051/);
    await prepare(s, bumped);
    s.i.type('go'); await s.i.expect(/ARM_FAILED_PAIR_UNAVAILABLE DO_NOT_CLICK/);
    s.i.type('status'); await s.i.expect(/ARM_STOP ARM_PHASE_FAILURE/);
    s.i.type('go'); await s.i.expect(/BLOCKED_ARM_STOPPED_ARM_PHASE_FAILURE DO_NOT_CLICK/);
    s.i.type('quit'); await s.i.expect(/\[quit\]/);
    const rec = receiptOf(s);
    assertReceiptV6(rec, ctx.cases);
    assert.deepEqual([rec.armStop, rec.cases[CASE].armFailure, rec.base.run.state], ['ARM_PHASE_FAILURE', 'PAIR_UNAVAILABLE', 'TERMINAL_INCOMPLETE']);
    assert.equal(rec.cases[CASE].armIssued, true, 'the consumption and the armIssued marker were persisted before the ARM');
    assert.equal(rec.base.cases.find((x: { caseId: string }) => x.caseId === CASE).outcome, 'ABANDONED_IN_FLIGHT', 'consumed, never re-armed');
  } finally {
    assert.deepEqual((await s.i.stop()).forced, []); assert.deepEqual((await s.o.stop()).forced, []);
  }
});

test('no browser handoff: abandon-handoff → finish records UNVERIFIED (TIMEOUT for the session); the next GO waits for the draining reader', skip, async () => {
  const s = await session();
  try {
    s.i.type('pair-ack'); s.i.type(s.ack); await s.i.expect(/PAIR_RECORDED/);
    await prepare(s, s.policyVersion);
    s.i.type('go'); await s.i.expect(/GO_CLICK_ASK_NOW RE-UNS-051 \d+/);
    const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question, observationId: null,
      acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion: s.policyVersion, questionDataClass: 'SYNTHETIC' } };
    const qres = await post(s.serverPort, askPath, JSON.stringify(body), browserHeaders(s.serverPort, bearer, { 'x-atlas-evaluation-session': s.sessionToken }));
    assert.equal(qres.status, 200, qres.body); // answered, but the browser never posts the RESPONSE handoff
    s.i.type('abandon-handoff'); await s.i.expect(/HANDOFF_ABANDONED_UNVERIFIED/);
    s.i.type('finish');
    const [, state] = await s.i.expect(/CASE_RECORDED RE-UNS-051 (\S+) UNVERIFIED/, 30000);
    s.i.type('go'); await s.i.expect(/BLOCKED_PREVIOUS_SLOT_LIVE DO_NOT_CLICK/);
    s.i.type('quit'); await s.i.expect(/\[quit\]/);
    const rec = receiptOf(s);
    assertReceiptV6(rec, ctx.cases);
    const c = rec.cases[CASE];
    assert.deepEqual([c.handoffState, c.handoffCode, c.handoff, c.terminal.final, c.terminal.publication.kind], ['UNVERIFIED', 'RAW_EXPIRED', null, true, 'ANSWER']);
    assert.deepEqual([c.abandonedByOperator, c.creditBlock], [true, null]);
    const record = rec.base.cases.find((x: { caseId: string }) => x.caseId === CASE);
    assert.equal(record.casePass, false, 'no credit without a verified handoff');
    console.log(`# REVAL_EVIDENCE RS-C-B unverified handoff: run ${state}, outcome ${record.outcome}, reply ${record.reply}`);
  } finally {
    assert.deepEqual((await s.i.stop()).forced, []); assert.deepEqual((await s.o.stop()).forced, []);
  }
});
