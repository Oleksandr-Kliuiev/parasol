import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import { fenceOf, PRICE, revise } from '../support/ask-remote-pg.ts';
import { LiveOwner } from '../support/reval-eval-process.ts';
import { LiveTty } from '../support/reval-live-tty.ts';
import { ACTOR, CLIENT, WS, install, ownerTx, pidOf, provisionSandbox, q, registration } from '../support/reval-fixture-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-C-C NB7 rehearsal on this target platform (darwin/arm64; 04 "RS-C must rehearse consecutive ARM/READY cycles on the
// target platform, report attempted/successful/failed arm counts and bounded latency, and demonstrate this distinction with
// injected failures before and after consumption"): O (live PTY) → C → S (BUILT bridge server, offline scripted provider answering
// each frozen question with its frozen intent) and the REAL RS-C-B instrument code under a live PTY (tests/support/reval-nb7-entry.ts)
// for 6 consecutive FX07 cases (rehearsal order), one injected PRE failure (nothing consumed) and one injected ARM failure after
// consumption (run stops). Docker PG17 = regression evidence only; never MEASURED.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only', timeout: 600_000 };
const ctx = bindCorpus(verifyRevision().snapshot); // identity FIRST: no throwaway database on a top-level failure
void ctx;
const ns = await nonsuperDatabase();
const { db } = ns; const owner = db.owner;
after(async () => { await ns.cleanup(); });
const physical = await dockerPhysical(ns.admin);
await ns.admin.end();
const helper = buildPeer(`${await privateDir('rscc-nb7')}/peer`);
const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole, digests.buildManifestSha256);
const pid = await pidOf(owner);
await registerSandbox(q(owner), r, [pid]);
await install(owner, r, 'FX07', '0', [pid]);
const bearer = generateToken();
await ownerTx(owner, () => owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-nb7', $2, $3)`, [WS, ACTOR, hashToken(bearer)]));
const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
const ownerEntry = fileURLToPath(new URL('../support/reval-test-owner-entry.ts', import.meta.url));
const driver = fileURLToPath(new URL('../support/reval-nb7-entry.ts', import.meta.url));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

test('NB7: consecutive ARM/READY cycles on the target platform with injected failures before and after consumption', skip, async () => {
  const dir = await privateDir('rscc-nb7-run'); const serverPort = 5300 + Math.floor(Math.random() * 300);
  const { path } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId,
    workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name }, roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole },
    physical, server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
  await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, provider: { intent: 'BY_QUESTION' } }));
  const o = new LiveOwner(dir, ownerEntry, ['--config', path]);
  try {
    await o.prompt();
    assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
    assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"allFiveIntents":true/);
    const policyVersion = await revise(owner, WS, { state: 'ACTIVE' });
    const now = Date.now();
    const input = await writePrivate(dir, 'nb7.json', JSON.stringify({ configDir: dir, registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId, port: serverPort,
      bearer, clientId: CLIENT, fixtureId: 'FX07', cycles: 6, policyVersion, receiptDir: join(dir, 'receipts'),
      admission: { admissionId, startUtc: new Date(now - 60_000).toISOString(), expiryUtc: new Date(now + 2 * 3_600_000).toISOString(), dayCapMicro: '2000000',
        monthCapMicro: '10000000', openingFenceEpoch: String(await fenceOf(owner, WS)), pacingMax: '10' } }));
    const i = new LiveTty(dir, driver, [input], 'nb7');
    try {
      const [, ctl, ho] = await i.expect(/CONNECTED ([0-9a-f-]{36}) ([0-9a-f-]{36})/, 60_000);
      const [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
      i.type(`PAIR ${secretLine!.split(' ')[2]} ${ackLine!.slice('OK PAIR_ACK '.length)}`);
      const [, summary] = await i.expect(/NB7_(?:SUMMARY|FAILED) (.*)/, 400_000);
      const s = JSON.parse(summary!.slice(summary!.indexOf('{'))) as { attempted: number; succeeded: number; failedBeforeConsumption: number; failedAfterConsumption: number;
        consumed: number; preToArmMs: number[]; armMs: number[]; readyMs: number[]; goToCommitMs: number[] };
      assert.ok(!i.transcript.includes('NB7_FAILED'), i.transcript.slice(-400));
      assert.deepEqual([s.attempted, s.succeeded, s.failedBeforeConsumption, s.failedAfterConsumption, s.consumed], [8, 6, 1, 1, 7]);
      assert.ok(Math.max(...s.preToArmMs) < 2000, 'PRE→ARM stays inside C\'s 2 s PRE-age bound');
      const show = (xs: number[]) => `min ${Math.min(...xs)} / p50 ${pct(xs, 0.5)} / max ${Math.max(...xs)} ms`;
      console.log(`# REVAL_EVIDENCE NB7 rehearsal (darwin/arm64, Docker PG17): attempted ${s.attempted}, successful ${s.succeeded}, failed before consumption `
        + `${s.failedBeforeConsumption} (unconsumed), failed after consumption ${s.failedAfterConsumption} (consumed, run stopped); PRE→ARM ${show(s.preToArmMs)} `
        + `(C's PRE-age bound 2000 ms); ARM ${show(s.armMs)}; `
        + `READY ${show(s.readyMs)}; GO→COMMIT ${show(s.goToCommitMs)}`);
    } finally { assert.deepEqual((await i.stop()).forced, []); }
  } finally { assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives'); }
});
