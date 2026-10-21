import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { loadCaseFixtures } from '../../packages/reval/eval-cases.ts';
import { decodeTransfer } from '../../packages/reval/eval-transient.ts';
import { decodeArmAck, decodePairAck, decodeTerminalObservation } from '../../packages/reval/eval-wire.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRICE, revise } from '../support/ask-remote-pg.ts';
import { answerResult } from '../support/reval-eval-fixtures.ts';
import { instrument, InstrumentProcess, LiveOwner } from '../support/reval-eval-process.ts';
import { askPath, browserHeaders, handoffPath, post } from '../support/reval-eval-server.ts';
import { ACTOR, CLIENT, WS, install, ownerTx, pidOf, provisionSandbox, q, registration } from '../support/reval-fixture-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-C-A process E2E on darwin/arm64 + Docker PG17 (rs-c/IMPLEMENTATION_BRIEF.md §1–§5): O = production owner CLI
// library under a REAL live PTY, C = production controller (Docker TCP seam, test-only ref), S = the BUILT bridge server with
// the RS-C-A composition and the scripted OFFLINE provider, I = the test instrument process under a REAL PTY on C's and S's
// measured unix sockets (actual pinned-helper peer proofs), the browser = raw loopback HTTP. One case through every hop, then
// the PAIR/ARM refusals of the controller and the loss of the control connection.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only' };
const ns = await nonsuperDatabase();
const { db } = ns; const owner = db.owner;
after(async () => { await ns.cleanup(); });
const physical = await dockerPhysical(ns.admin);
await ns.admin.end();
const work = await privateDir('evale2e');
const helper = buildPeer(`${work}/peer`);
const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole, digests.buildManifestSha256);
const pid = await pidOf(owner);
await registerSandbox(q(owner), r, [pid]);
await install(owner, r, 'FX02', '0', [pid]);
const bearer = generateToken();
await ownerTx(owner, () => owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-e2e', $2, $3)`, [WS, ACTOR, hashToken(bearer)]));
const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
const ownerEntry = fileURLToPath(new URL('../support/reval-test-owner-entry.ts', import.meta.url));
const fx02Cases = [...loadCaseFixtures()].filter(([, f]) => f === 'FX02').map(([c]) => c);
const otherCase = [...loadCaseFixtures()].find(([, f]) => f !== 'FX02')![0];
let n = 0; let port = 4200 + Math.floor(Math.random() * 300);

async function session() {
  await revise(owner, WS, { state: 'PAUSED' });
  const dir = await privateDir(`e2e${++n}`); const serverPort = ++port;
  const { path } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId,
    workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name }, roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole },
    physical, server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
  await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, provider: { intent: 'SUMMARY' } }));
  const o = new LiveOwner(dir, ownerEntry, ['--config', path]);
  await o.prompt();
  return { dir, o, serverPort };
}
const failure = (x: { kind: string; payload: any }) => x.kind === 'FAILURE' ? x.payload.code : `OK ${x.kind}`;
/** What the test verifier recorded about an unexpected error (V itself answers a bare INTERNAL_FAILURE). */
const verifierErrors = (dir: string): string => { try { return readFileSync(join(dir, 'verifier-errors.log'), 'utf8'); } catch { return 'no verifier error recorded'; } };

test('one case O → C → S with I and the browser: FIXTURE_CHECK, PAIR (+ secret), PAIR200, PRE, ARM, READY, answer, handoff, journaled observation', skip, async () => {
  const { dir, o, serverPort } = await session();
  let inst: InstrumentProcess | null = null;
  try {
    const checked = (await o.type('fixture-check'))[0]!;
    assert.match(checked, /^OK FIXTURE_CHECK .*"financeUnchanged":true/, `${checked}; ${verifierErrors(dir)}`);
    const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
    const i = await instrument(dir, r); inst = i.inst;
    const [ackLine, secretLine] = await o.type(`pair ${i.controlId} ${i.handoffId}`, 2);
    const pairAck = decodePairAck(JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)));
    assert.equal(pairAck.paired, false);
    const [, , nonce] = secretLine!.split(' ');
    assert.ok(!ackLine!.includes(nonce!), 'the nonce is never in the safe payload');
    const p = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce }),
      browserHeaders(serverPort, bearer));
    assert.equal(p.status, 200, p.body);
    const pair200 = JSON.parse(p.body);
    assert.equal(pair200.pairId, pairAck.pairId);
    const pre = await i.request('SNAPSHOT', {});
    assert.deepEqual([pre.kind, pre.emitter, pre.payload.policyState], ['SNAPSHOT', 'CONTROLLER', 'ACTIVE']);
    const caseId = fx02Cases[0]!;
    const armReq = { caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId, policyVersion, preSnapshotId: pre.payload.snapshotId, browserPairId: pairAck.pairId };
    const tArm = performance.now();
    const arm = await i.request('ARM_CASE', armReq);
    const armMs = performance.now() - tArm;
    assert.deepEqual([arm.kind, arm.emitter], ['ARM_ACK', 'SERVER'], JSON.stringify(arm.payload));
    const ack = decodeArmAck(arm.payload);
    assert.equal(failure(await i.request('ARM_CASE', armReq)), 'CASE_CONSUMED', 'a repeat never arms again');
    const tReady = performance.now();
    await i.handoff({ contractVersion: 'RevalTransientReadyV1', registrationId: r.registrationId, serverBootId: i.serverBootId, challenge: randomUUID(),
      pairId: pairAck.pairId, armId: ack.armId, caseId, fixtureId: 'FX02', fixtureGeneration: '1', admissionId, policyVersion, preSnapshotId: ack.preSnapshotId });
    assert.equal((await i.inst.next('ho')).disposition, 'READY');
    const readyMs = performance.now() - tReady;
    const body = { contractVersion: 'AskRequestV2', requestId: randomUUID(), question: 'What needs attention for this client right now?', observationId: 'syn-obs-b2',
      acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion, questionDataClass: 'SYNTHETIC' } };
    const qres = await post(serverPort, askPath, JSON.stringify(body), browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': pair200.sessionToken }));
    assert.equal(qres.status, 200, qres.body);
    const tPost = performance.now();
    const handoff = post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: pairAck.pairId,
      receiptNonce: qres.headers['x-atlas-evaluation-receipt'], request: body,
      response: { status: 200, correlationId: qres.headers['x-atlas-correlation-id'], body: JSON.parse(qres.body) } }),
    browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': pair200.sessionToken }));
    const t = decodeTransfer(await i.inst.next('ho'));
    await i.handoff({ contractVersion: 'RevalTransientAckV1', challenge: t.ackChallenge, transferSequence: t.sequence, transferId: t.transferId, binding: t.binding,
      commitChallenge: randomUUID(), disposition: 'ACCEPTED', result: answerResult, failureCode: null });
    assert.equal((await i.inst.next('ho')).disposition, 'COMMITTED');
    const commitMs = performance.now() - tPost;
    assert.equal((await handoff).status, 204);
    assert.ok(commitMs < 2000, `POST→COMMIT ${commitMs.toFixed(0)} ms inside the 2 s handoff deadline`);
    let obs: any = null; let collectMs = 0;
    for (let k = 0; k < 40 && !(obs && obs.final); k += 1) {
      const tc = performance.now();
      const x = await i.request('TERMINAL_OBSERVATION', { armId: ack.armId });
      collectMs = performance.now() - tc;
      assert.deepEqual([x.kind, x.emitter], ['TERMINAL_OBSERVATION', 'SERVER']);
      obs = decodeTerminalObservation(x.payload);
      if (!obs.final) await new Promise(res => setTimeout(res, 50));
    }
    assert.ok(obs.final && obs.settlement === 'CONFIRMED' && obs.publication.state === 'SERVER_FINISHED');
    // NB7 (rc2): measured on this host through the Docker TCP seam (regression evidence; the target-platform rehearsal is RS-C-C).
    console.log(`# REVAL_EVIDENCE NB7 ARM ${armMs.toFixed(0)} ms, READY ${readyMs.toFixed(0)} ms, POST→COMMIT ${commitMs.toFixed(0)} ms, TERMINAL_OBSERVATION+journal fsync ${collectMs.toFixed(0)} ms`);
    const journal = readFileSync(join(dir, 'reval-journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(journal.at(-1).record, obs, 'C journaled exactly the forwarded record');
    for (const secret of [nonce!, pair200.sessionToken, String(qres.headers['x-atlas-evaluation-receipt']), body.question, bearer]) {
      assert.ok(!readFileSync(join(dir, 'reval-journal.jsonl'), 'utf8').includes(secret), 'no secret or raw value in the journal');
    }
    assert.match((await o.type(`end-pair ${pairAck.pairId}`))[0]!, /^OK PAIR_ACK /);
    const after2 = await post(serverPort, askPath, JSON.stringify(body), browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': pair200.sessionToken }));
    assert.equal(after2.status, 503);
  } finally {
    await inst?.stop();
    assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives');
  }
});

test('controller refusals: PAIR needs a current FIXTURE_CHECK and live instrument ids; I cannot PAIR; an ARM failure after consumption stops arming (NB9); control loss ends the pair', skip, async () => {
  const { dir, o, serverPort } = await session();
  let inst: InstrumentProcess | null = null;
  try {
    assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /, 'the first operation runs C startup (and launches S)');
    const i = await instrument(dir, r); inst = i.inst;
    assert.deepEqual(await o.type(`pair ${i.controlId} ${i.handoffId}`), ['FAILURE FIXTURE_MISMATCH'], 'no FIXTURE_CHECK in this session');
    assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK /);
    const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
    assert.deepEqual(await o.type(`pair ${randomUUID()} ${i.handoffId}`), ['FAILURE PAIR_UNAVAILABLE'], 'unknown control connection');
    assert.equal(failure(await i.request('PAIR', { instrumentControlConnectionId: i.controlId, instrumentHandoffConnectionId: i.handoffId })), 'OWNER_REQUIRED');
    const [ackLine, secretLine] = await o.type(`pair ${i.controlId} ${i.handoffId}`, 2);
    const pairAck = decodePairAck(JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)));
    const nonce = secretLine!.split(' ')[2]!;
    const p = await post(serverPort, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce }), browserHeaders(serverPort, bearer));
    const session = JSON.parse(p.body).sessionToken as string;
    const pre = await i.request('SNAPSHOT', {});
    const arm = (caseId: string, fixtureId = 'FX02', preId = pre.payload.snapshotId) => i.request('ARM_CASE', { caseId, fixtureId, fixtureGeneration: '1', admissionId,
      policyVersion, preSnapshotId: preId, browserPairId: pairAck.pairId });
    assert.equal(failure(await arm(fx02Cases[0]!, 'FX02', randomUUID())), 'SNAPSHOT_STALE', 'PRE must be a snapshot C exported to this connection');
    // NB9 (rc2): that failure after consumption stopped arming in this controller — no automatic continuation to another case.
    assert.equal(failure(await arm(fx02Cases[1]!)), 'ARM_UNAVAILABLE');
    assert.equal(failure(await arm(fx02Cases[0]!)), 'CASE_CONSUMED');
    assert.equal(failure(await arm(otherCase)), 'ARM_UNAVAILABLE');
    await i.inst.close('ctl');
    await new Promise(res => setTimeout(res, 500));
    const qres = await post(serverPort, askPath, '{}', browserHeaders(serverPort, bearer, { 'x-atlas-evaluation-session': session }, 2));
    assert.equal(qres.status, 503, 'the pair ended with the control connection');
  } finally {
    await inst?.stop();
    assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives');
  }
});
