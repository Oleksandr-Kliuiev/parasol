import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATASET_MANIFEST_SHA256, SEED_MAPPING_SHA256 } from '../../packages/reval/dataset.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { decodeFixtureCheck } from '../../packages/reval/payloads.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { adminUrl } from '../support/pg-harness.ts';
import { PRICE, revise } from '../support/ask-remote-pg.ts';
import { ACTOR, CLIENT, WS, install, pidOf, provisionSandbox, q, registration } from '../support/reval-fixture-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { PtySession, waitGone } from '../support/reval-pty.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-B FIXTURE_CHECK end to end on darwin/arm64 (rs-b brief B8/B9): O = production owner CLI library under a REAL
// PTY, C = production controller with the Docker TCP seam (test-only ref, never MEASURED), V = production verifier library
// spawned by C with the actual peer proof. The sandbox is the frozen fixture scope, registered and switched by the RS-B
// maintenance code before the session (no other backend may exist during a switch). Results: the exact 03 payload, the
// 1800 ms budget, a stale generation during V, a suspended actor, and no surviving verifier process or backend.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only' };
const ns = await nonsuperDatabase();
const { db } = ns; const owner = db.owner;
const physical = await dockerPhysical(ns.admin);
await ns.admin.end();
after(async () => { await ns.cleanup(); });
const work = await privateDir('fxcheck');
const helper = buildPeer(`${work}/peer`);
const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole, digests.buildManifestSha256);
const pid = await pidOf(owner);
await registerSandbox(q(owner), r, [pid]);
await install(owner, r, 'FX02', '0', [pid]);
const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
const ownerEntry = fileURLToPath(new URL('../support/reval-test-owner-entry.ts', import.meta.url));
let n = 0;
async function session(lines: string[], extra: Record<string, unknown> = {}) {
  const dir = await privateDir(`fx${++n}`);
  const { path } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: r.registrationId, databaseInstanceId: r.databaseInstanceId,
    workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256,
    endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name }, roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole },
    physical, server: { mode: 'NONE', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: 3999 } } as never,
  { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
  await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, controllerFdProbe: `${dir}/c.fds`, ...extra }));
  return Object.assign(new PtySession(dir, ownerEntry, ['--config', path], lines), { dir });
}
async function superuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const a = new URL(adminUrl()); a.pathname = `/${db.name}`;
  const c = new pg.Client({ connectionString: a.toString() }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const payload = (line: string) => decodeFixtureCheck(JSON.parse(line.slice('OK FIXTURE_CHECK '.length)));

test('FIXTURE_CHECK through C → V: exact 03 payload, every proof true, within the 1800 ms budget; V and its backend gone', skip, async () => {
  const s = await session(['snapshot', 'fixture-check', 'fixture-check', 'quit']);
  try {
    assert.ok(await s.exited(60000), 'session ended');
    const lines = s.results.map(x => x.line);
    assert.match(lines[0]!, /^OK SNAPSHOT /);
    for (const i of [1, 2]) {
      assert.match(lines[i]!, /^OK FIXTURE_CHECK /, lines.join(' | '));
      assert.deepEqual(payload(lines[i]!), { fixtureId: 'FX02', fixtureGeneration: '1', datasetManifestSha256: DATASET_MANIFEST_SHA256,
        seedMappingSha256: SEED_MAPPING_SHA256, syntheticFreshnessAt: '2026-10-10T07:30:00.000Z', sourceMode: 'db', rowIdentity: true, sourceProjection: true,
        expectedFacts: true, allFiveIntents: true, financeUnchanged: true, realTimeFreshnessClaim: false });
      const ms = s.results[i]!.at - s.results[i - 1]!.at;
      assert.ok(ms < 2000, `answered after ${ms.toFixed(0)} ms`);
      console.log(`# REVAL_EVIDENCE FIXTURE_CHECK latency ${ms.toFixed(0)} ms (Docker TCP seam; regression evidence only)`);
    }
    const left = await superuser(c => c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-v-verifier'`, [db.name]));
    assert.equal(left.rows[0].n, 0, 'no verifier backend survives');
  } finally { assert.deepEqual((await s.stop()).forced, [], 'no O/C/V process survives'); }
});

/** RS-C-A (RS-B N3): wait for the verifier's own start marker (written right after its connect), not for pg_stat_activity. */
async function verifierStarted(marker: string): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < 15000) { if (existsSync(marker)) return true; await new Promise(res => setTimeout(res, 5)); }
  return false;
}
const vHooks = (extra: Record<string, unknown> = {}) => { const verifierMarkerFile = `${work}/v-${randomUUID()}.marker`;
  return { marker: verifierMarkerFile, extra: { hooks: { verifierSleepMs: 300, verifierMarkerFile, ...extra } } }; };

test('a generation change while V runs → FIXTURE_MISMATCH (never a stale success); the next check proves the new generation', skip, async () => {
  // RS-B N3: `snapshot` first absorbs C's startup (the first operation's sub-budget); V's start marker synchronises the change.
  const h = vHooks();
  // RS-C-A rc2 (review F13): under parallel load a later check may itself time out (fail-closed); one more check is allowed, but
  // never a stale success: every OK proves the NEW generation and at least one OK is required.
  const s = await session(['snapshot', 'fixture-check', 'fixture-check', 'fixture-check', 'quit'], h.extra);
  try {
    assert.ok(await verifierStarted(h.marker), 'the verifier connected');
    await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    await owner.query(`UPDATE "RevalFixtureBinding" SET generation = generation + 1 WHERE "registrationId" = $1`, [r.registrationId]); await owner.query('COMMIT');
    assert.ok(await s.exited(60000));
    const lines = s.results.map(x => x.line);
    assert.match(lines[0]!, /^OK SNAPSHOT /);
    assert.equal(lines[1], 'FAILURE FIXTURE_MISMATCH');
    const later = lines.slice(2, 4);
    assert.ok(later.every(l => /^OK FIXTURE_CHECK /.test(l) || /^FAILURE [A-Z_]+$/.test(l)), later.join(' | '));
    const ok = later.filter(l => /^OK FIXTURE_CHECK /.test(l));
    assert.ok(ok.length >= 1, later.join(' | '));
    for (const l of ok) assert.equal(payload(l).fixtureGeneration, '2', 'never a stale success');
  } finally { assert.deepEqual((await s.stop()).forced, []); }
});

test('RS-B N1 (P3): the policy turns ACTIVE while V runs → snapshot #2 refuses POLICY_CHANGED (no positive payload)', skip, async () => {
  const h = vHooks();
  const s = await session(['snapshot', 'fixture-check', 'quit'], h.extra);
  try {
    assert.ok(await verifierStarted(h.marker));
    await revise(owner, WS, { state: 'ACTIVE' });
    assert.ok(await s.exited(60000));
    assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE POLICY_CHANGED']);
  } finally { assert.deepEqual((await s.stop()).forced, []); await revise(owner, WS, { state: 'PAUSED' }); }
});

test('RS-B N1 (P1, F9): V connected as the table owner is refused UNAUTHORIZED by the accepted runtime confinement check', skip, async () => {
  const s = await session(['snapshot', 'fixture-check', 'quit'], { hooks: { verifierRole: ns.ownerRole } });
  try { assert.ok(await s.exited(60000)); assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE UNAUTHORIZED']); }
  finally { assert.deepEqual((await s.stop()).forced, []); }
});

test('RS-B N1 (P2, F6): a source-read statement timeout is DEADLINE, never all-false proof booleans', skip, async () => {
  const s = await session(['snapshot', 'fixture-check', 'quit'], { hooks: { verifierStallSourceRead: true } });
  try { assert.ok(await s.exited(60000)); assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE DEADLINE']); }
  finally { assert.deepEqual((await s.stop()).forced, []); }
});

test('the verifier re-checks current authority without a bearer: suspended designated actor → FAILURE UNAUTHORIZED', skip, async () => {
  await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)`, [WS, ACTOR]);
  await owner.query(`UPDATE "Actor" SET status = 'DISABLED' WHERE id = $1`, [ACTOR]); await owner.query('COMMIT');
  const s = await session(['snapshot', 'fixture-check', 'quit']); // RS-B N3: `snapshot` absorbs startup
  try {
    assert.ok(await s.exited(60000));
    assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE UNAUTHORIZED']);
    const cPid = Number(JSON.parse(readFileSync(`${s.dir}/c.fds`, 'utf8')).pid);
    assert.ok(await waitGone([cPid], 5000));
  } finally {
    assert.deepEqual((await s.stop()).forced, []);
    await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)`, [WS, ACTOR]);
    await owner.query(`UPDATE "Actor" SET status = 'ACTIVE' WHERE id = $1`, [ACTOR]); await owner.query('COMMIT');
  }
});

test('rc2 F1: FIXTURE_CHECK permits only the PAUSED binding — an ACTIVE policy is refused POLICY_CHANGED (no positive payload)', skip, async () => {
  await revise(owner, WS, { state: 'ACTIVE' });
  try {
    const s = await session(['snapshot', 'fixture-check', 'quit']); // RS-B N3: `snapshot` absorbs startup
    try { assert.ok(await s.exited(60000)); assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE POLICY_CHANGED']); }
    finally { assert.deepEqual((await s.stop()).forced, []); }
  } finally { await revise(owner, WS, { state: 'PAUSED' }); }
});

test('rc2 F3: an accounting change while V runs → financeUnchanged:false (all other proofs still true)', skip, async () => {
  const h = vHooks();
  const s = await session(['snapshot', 'fixture-check', 'quit'], h.extra);
  try {
    assert.ok(await verifierStarted(h.marker), 'the verifier connected');
    await revise(owner, WS, { dayCapMicroUsd: '1500000' });
    assert.ok(await s.exited(60000));
    const lines = s.results.map(x => x.line).slice(1);
    assert.match(lines[0]!, /^OK FIXTURE_CHECK /, lines.join(' | '));
    const p = payload(lines[0]!);
    assert.equal(p.financeUnchanged, false);
    assert.deepEqual([p.rowIdentity, p.sourceProjection, p.expectedFacts, p.allFiveIntents], [true, true, true, true]);
  } finally { assert.deepEqual((await s.stop()).forced, []); }
});

test('rc2 F3: a generation change AFTER V committed (before snapshot #2) → FIXTURE_MISMATCH, never a stale success', skip, async () => {
  const marker = `${work}/stall-${Date.now()}.marker`;
  // RS-B N3: `snapshot` first absorbs startup. begin #1 = startup wrapper, #2 = the SNAPSHOT operation, #3 = FIXTURE_CHECK snapshot #1,
  // #4 = snapshot #2 (after V returned): stall #4 and bump the generation meanwhile.
  const s = await session(['snapshot', 'fixture-check', 'quit'], { stallReaderBeginNumber: 4, stallReaderBeginMs: 400, stallMarkerFile: marker });
  try {
    const t = Date.now();
    while (Date.now() - t < 15000 && !existsSync(marker)) await new Promise(res => setTimeout(res, 5));
    assert.ok(existsSync(marker), 'C reached snapshot #2 after V');
    await owner.query('BEGIN'); await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    await owner.query(`UPDATE "RevalFixtureBinding" SET generation = generation + 1 WHERE "registrationId" = $1`, [r.registrationId]); await owner.query('COMMIT');
    assert.ok(await s.exited(60000));
    assert.deepEqual(s.results.map(x => x.line).slice(1), ['FAILURE FIXTURE_MISMATCH']);
  } finally { assert.deepEqual((await s.stop()).forced, []); }
});

