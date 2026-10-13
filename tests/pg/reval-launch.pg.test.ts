import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { openSync, fstatSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { encodeFrame, PRIVATE_FRAME_CAP } from '../../packages/reval/frame.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { NODE_REALPATH, privateDir } from '../support/reval-test-deps.ts';
import { alive, childrenOf, waitGone } from '../support/reval-pty.ts';
import { launchHarness } from '../support/reval-launch-harness.ts';

// R-EVAL RS-A launch on darwin/arm64 (ACCEPTANCE_CHECKS "launch"): O (production owner CLI library) under a REAL PTY →
// test controller entry (production controller + Docker TCP seam) → BUILT API bridge library + built API modules → test
// executor entry. Real Darwin peer proofs throughout; TEST-ONLY ref rsa-test-tcp-unverified-v1 (never MEASURED). The
// owner credential is the NOSUPERUSER NOBYPASSRLS table owner. Elsewhere the controller refuses (unit gate test).
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const n = await nonsuperDatabase();
after(() => n.cleanup());
const { db, admin } = n;
const lh = await launchHarness(n);
const { helper, tcp, physical } = lh;
const session = lh.session;
const SECRETS = { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: n.ownerPassword };
const READY = Array.from({ length: 12 }, () => 'identity');
const isOkId = (r: { line: string }) => r.line.startsWith('OK IDENTITY ');
const kv = (line: string) => JSON.parse(line.slice(line.indexOf('{')));
const devNull = statSync('/dev/null');
type Fd = { fd: number; dev: number; ino: number; type: string };
/**
 * Inheritance classification at first JS entry: 0–2 must be /dev/null, 3 the private socketpair end. File/dir sentinels are
 * matched by type + dev/ino. macOS fstat reports TCP sockets (and libuv's kqueue/FIFOs) as dev 0 / ino 0, so sockets are
 * classified structurally: at first JS entry the ONLY legitimate socket is fd 3 (libuv's own descriptors are FIFOs/dirs),
 * any other socket counts as a leak; live processes are additionally checked with lsof for the parent's sentinel ports.
 */
const inherited = (fds: Fd[], sentinels: { kind: string; dev: number; ino: number }[]) => ({
  stdioDevNull: [0, 1, 2].every(i => fds.some(f => f.fd === i && f.dev === devNull.dev && f.ino === devNull.ino)),
  fd3Socket: fds.some(f => f.fd === 3 && f.type === 'socket'),
  sentinelLeaks: fds.filter(f => (f.type === 'file' || f.type === 'dir') && sentinels.some(x => !x.kind.endsWith('socket') && x.dev === f.dev && x.ino === f.ino)).length
    + fds.filter(f => f.type === 'socket' && f.fd !== 3).length,
});
const tcpPorts = (pid: number): string[] => { try { return [...execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-iTCP', '-nP', '-F', 'n'], { encoding: 'utf8' }).matchAll(/^n(.*)$/gm)].map(m => m[1]!); } catch { return []; } };

test('O without a TTY is refused before anything starts', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  // The PRODUCTION owner entry, with no terminal on stdin/stdout.
  const r = spawnSync(process.execPath, [`${PROJECT_ROOT}/scripts/reval-server/owner.ts`, '--config', '/nonexistent/config.json'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(r.status, 2); assert.match(r.stdout, /^REFUSED NO_TTY$/m);
});

test('real PTY O→C→S→E: IDENTITY UNVERIFIED with the test ref, SNAPSHOT, PAUSE_EXPORT; inheritance allowlist + sentinel leak detector; no secrets; timing', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const s = await session('LAUNCH', p => {
    const v1 = String(BigInt(p.policyVersion) + 1n);
    const timing = Array.from({ length: 20 }, () => ['identity', `pause-export ${p.admissionId} ${v1} 0 0`]).flat();
    return [...READY, 'snapshot', `pause-export ${p.admissionId} ${p.policyVersion} 0 0`, 'process-census', 'drain', 'platform-proof', 'privacy-proof', 'fixture-check',
      'select * from x', ...timing, 'quit'];
  });
  try {
    const first = await s.pty.waitFor(isOkId, 30000);
    // While the session runs: topology, TTYs, children, credentials, backends (C, S alive).
    const cProbe = JSON.parse(await readFile(s.probes.controllerFdProbe, 'utf8')); const sProbe = JSON.parse(await readFile(s.probes.serverFdProbe, 'utf8'));
    for (const pid of [cProbe.pid, sProbe.pid]) assert.equal(execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim(), '??', 'no controlling TTY');
    assert.deepEqual(childrenOf(sProbe.pid), [], 'S spawns no children');
    const cPorts = JSON.parse(await readFile(s.probes.sentinelFile, 'utf8')).filter((x: { kind: string }) => x.kind === 'listening-socket').map((x: { port: number }) => `:${x.port}`);
    for (const port of cPorts) assert.ok(!tcpPorts(sProbe.pid).some(a => a.includes(port)), 'S holds no C sentinel listener');
    const ps = execFileSync('/bin/ps', ['eww', '-o', 'command=', '-p', `${cProbe.pid},${sProbe.pid}`], { encoding: 'utf8' });
    for (const secret of Object.values(SECRETS)) assert.ok(!ps.includes(secret), 'no credential in argv/env of C or S');
    const backends = (await admin.query(`SELECT application_name AS a, usename::text AS u FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'atlas-reval-%'`, [db.name])).rows;
    assert.ok(backends.some(b => b.a === 'atlas-reval-c-reader'), 'C reader session present');
    assert.ok(backends.every(b => (b.a === 'atlas-reval-c-reader' && b.u === db.revalReaderRole) || (b.a === 'atlas-reval-s-runtime' && b.u === db.runtimeRole)
      || (b.a === 'atlas-reval-e-owner' && b.u === n.ownerRole)), JSON.stringify(backends));
    await admin.query(`SET ROLE "${db.revalReaderRole}"`);
    const visible = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-s-runtime' AND usename IS NOT NULL`, [db.name])).rows[0].n;
    await admin.query('RESET ROLE');
    console.log(`# REVAL_EVIDENCE pg_stat_activity cross-check visible to reader: ${visible > 0 ? 'VERIFIED' : 'UNAVAILABLE'}`);
    assert.ok(await s.pty.exited(60000), 'quit ends the session'); assert.ok(await waitGone([cProbe.pid, sProbe.pid], 8000), 'O exit → C and S gone');
    const r = s.pty.results.map(x => x.line);
    assert.ok(r.slice(0, first).every(l => l === 'FAILURE IDENTITY_UNVERIFIED'), 'before S is bound IDENTITY never claims a server');
    const id = kv(r[first]!);
    assert.equal(id.loadedBinding, 'UNVERIFIED'); assert.equal(id.platformEvidenceRef, 'rsa-test-tcp-unverified-v1');
    assert.equal(id.databaseInstanceId, s.reg.databaseInstanceId); assert.equal(id.buildManifestSha256, s.digests.buildManifestSha256);
    const k = READY.length;
    assert.ok(r.slice(first, k).every(l => l.startsWith('OK IDENTITY ')));
    assert.match(r[k]!, /^OK SNAPSHOT /); assert.equal(kv(r[k]!).admissionId, s.p.admissionId);
    const c = kv(r[k + 1]!); assert.match(r[k + 1]!, /^OK CLOSURE /);
    assert.deepEqual(Object.keys(c).sort(), ['admissionId', 'fenceEpoch', 'paused', 'policyVersion']); assert.equal(c.paused, true);
    // RS-D-A: PROCESS_CENSUS is S's guard census (COMPLETE, idle); DRAIN is C's composition. RS-D-B: the harness's own owner/superuser
    // sessions are in the database, so C's process inventory is incomplete and DRAIN is UNKNOWN (never QUIESCENT) — continuity intact.
    assert.match(r[k + 2]!, /^OK PROCESS_CENSUS .*"coverage":"COMPLETE"/); assert.equal(kv(r[k + 2]!).activeTaskCount, '0');
    const drain = kv(r[k + 3]!); assert.match(r[k + 3]!, /^OK DRAIN /);
    assert.deepEqual([drain.state, drain.continuity, drain.reachableProcessCount, drain.policyVersion], ['UNKNOWN', 'INTACT', '1', c.policyVersion]);
    // RS-D-B: C's platform proof (S under the pinned Seatbelt profile: process tree COMPLETE; destinations UNKNOWN; 4 unenforced
    // components) and privacy proof (config directory scanned; declared outside destinations unreadable) — neither a verified zero.
    const platform = kv(r[k + 4]!); const privacy = kv(r[k + 5]!);
    assert.match(r[k + 4]!, /^OK PLATFORM_PROOF /); assert.match(r[k + 5]!, /^OK PRIVACY_PROOF /);
    assert.deepEqual([platform.policyEvidenceRef, platform.processCoverage, platform.destinationCoverage, platform.unmeasuredProcessCount, platform.mode,
      platform.countsAsVerifiedZero, platform.environmentId, platform.buildManifestSha256], ['rsd-seatbelt-s-v2', 'COMPLETE', 'UNKNOWN', '4', 'MEASURED', false,
      s.reg.registrationId, s.digests.buildManifestSha256]);
    assert.deepEqual([privacy.forbiddenContentMatchCount, privacy.metadataViolationCount, privacy.externalRetentionEvidenceRef, privacy.countsAsVerifiedZero],
      ['0', '0', null, false]);
    assert.ok(Number(privacy.unreadableDestinationCount) >= 6 && Number(privacy.coveredDestinationCount) >= 5, JSON.stringify(privacy));
    assert.equal(r[k + 6], 'FAILURE REGISTRATION_MISMATCH');
    assert.equal(r[k + 7], 'REFUSED GRAMMAR');
    const timed = s.pty.results.slice(k + 8, k + 48);
    assert.equal(timed.length, 40);
    const lat: Record<string, number[]> = { identity: [], pause: [] };
    timed.forEach((x, i) => { assert.match(x.line, i % 2 === 0 ? /^OK IDENTITY / : /^OK CLOSURE /); lat[i % 2 === 0 ? 'identity' : 'pause']!.push(x.at - s.pty.results[k + 7 + i]!.at); });
    for (const [name, v] of Object.entries(lat)) {
      const sorted = [...v].sort((a, b) => a - b);
      console.log(`# REVAL_EVIDENCE timing ${name} p50=${sorted[10]!.toFixed(1)}ms max=${sorted[19]!.toFixed(1)}ms (inter-arrival under the PTY; Docker TCP: regression only)`);
      assert.ok(sorted[19]! < 1800, `${name} max ${sorted[19]} ms`);
    }
    for (const secret of Object.values(SECRETS)) assert.ok(!s.pty.transcript.includes(secret), 'no credential in the O transcript');
    // Inheritance allowlist: 0–2 /dev/null, 3 the private socketpair end; no parent sentinel (O's for C, C's for S and E).
    const eProbe = JSON.parse(await readFile(s.probes.fdProbeFile, 'utf8'));
    const oSentinels = JSON.parse(await readFile(`${s.dir}/owner-sentinels.json`, 'utf8')); const cSentinels = JSON.parse(await readFile(s.probes.sentinelFile, 'utf8'));
    assert.deepEqual(inherited(cProbe.fds, oSentinels), { stdioDevNull: true, fd3Socket: true, sentinelLeaks: 0 });
    for (const probe of [sProbe, eProbe]) assert.deepEqual(inherited(probe.fds, cSentinels), { stdioDevNull: true, fd3Socket: true, sentinelLeaks: 0 }, probe.role);
    // macOS libc adds __CF_USER_TEXT_ENCODING (a text-encoding code, never a credential) at exec when absent: not parent-supplied.
    const supplied = (env: string[]) => env.filter(k => k !== '__CF_USER_TEXT_ENCODING');
    assert.deepEqual(supplied(cProbe.env), ['ATLAS_REVAL_CONFIG', 'ATLAS_REVAL_CONNECTION_ID', 'ATLAS_REVAL_SERVER_BOOT_ID']);
    assert.deepEqual(supplied(sProbe.env), ['ATLAS_API_PORT', 'ATLAS_MODE', 'ATLAS_REVAL_BRIDGE_FD']);
    assert.deepEqual((await readFile(s.probes.secretLog, 'utf8')).trim().split('\n'), [`${s.dir}/secrets/reader`], 'C reads only the reader secret');
    // rc2 (review F1), at the fs level and with the O-initiated privacy-proof above: C opened the reader file, never the owner or runtime one.
    assert.deepEqual([...new Set((await readFile(s.probes.fsSecretLog, 'utf8')).trim().split('\n'))], ['reader'], 'C never opens secretFiles.owner/runtime');
  } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
});

test('IDENTITY re-proves pid AND pidversion: a changed incarnation kills S; S killed → no relaunch; NONE mode never claims a server', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const forged = await session('LAUNCH', () => [...READY, 'identity', 'snapshot', 'quit'], { alterPidversionAfter: 2 });
  try {
    const i = await forged.pty.waitFor(isOkId, 30000);
    const sPid = JSON.parse(await readFile(forged.probes.serverFdProbe, 'utf8')).pid;
    await forged.pty.exited(30000);
    const r = forged.pty.results.map(x => x.line);
    assert.equal(r[i + 1], 'FAILURE IDENTITY_UNVERIFIED', 'same pid, different pidversion');
    assert.ok(r.slice(i + 1, READY.length + 1).every(l => l === 'FAILURE IDENTITY_UNVERIFIED'));
    assert.match(r[READY.length + 1]!, /^OK SNAPSHOT /, 'SNAPSHOT does not depend on S');
    assert.ok(await waitGone([sPid], 3000), 'S killed');
  } finally { assert.deepEqual((await forged.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  const killed = await session('LAUNCH', () => [...READY, ...Array.from({ length: 200 }, () => 'identity'), 'quit']);
  try {
    const i = await killed.pty.waitFor(isOkId, 30000);
    const cPid = JSON.parse(await readFile(killed.probes.controllerFdProbe, 'utf8')).pid; const sPid = JSON.parse(await readFile(killed.probes.serverFdProbe, 'utf8')).pid;
    process.kill(sPid, 'SIGKILL'); assert.ok(await waitGone([sPid], 3000));
    const f = await killed.pty.waitFor((x, j) => j > i && x.line === 'FAILURE IDENTITY_UNVERIFIED', 20000);
    assert.equal(childrenOf(cPid).filter(p => p !== sPid && alive(p)).length, 0, 'no relaunch');
    await killed.pty.exited(30000);
    assert.ok(killed.pty.results.slice(f).every(x => x.line === 'FAILURE IDENTITY_UNVERIFIED'), 'S stays LOST');
  } finally { assert.deepEqual((await killed.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  const none = await session('NONE', () => ['identity', 'snapshot', 'quit']);
  try {
    await none.pty.exited(30000);
    const r = none.pty.results.map(x => x.line);
    assert.equal(r[0], 'FAILURE IDENTITY_UNVERIFIED'); assert.match(r[1]!, /^OK SNAPSHOT /);
  } finally { assert.deepEqual((await none.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
});

test('RS-D-B: an S launched WITHOUT the pinned Seatbelt profile is refused before it listens — IDENTITY never OK, no platform proof, S killed', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const bare = await session('LAUNCH', () => [...READY, 'platform-proof', 'drain', 'quit'], { noSandbox: true });
  try {
    await bare.pty.exited(60000);
    const sPid = JSON.parse(await readFile(bare.probes.serverFdProbe, 'utf8')).pid as number;
    const r = bare.pty.results.map(x => x.line);
    assert.ok(r.slice(0, READY.length).every(l => l === 'FAILURE IDENTITY_UNVERIFIED'), r.slice(0, READY.length).join('|'));
    assert.equal(r[READY.length], 'FAILURE PLATFORM_UNVERIFIED');
    assert.match(r[READY.length + 1]!, /^(FAILURE |OK DRAIN .*"state":"UNKNOWN")/, 'never QUIESCENT without an enforced S');
    assert.ok(await waitGone([sPid], 3000), 'the unsandboxed S is killed');
  } finally { assert.deepEqual((await bare.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
});

test('after the peer proof, startup (3)–(5) failures are authenticated FAILUREs with approved codes for every op; S never launched; no extra local exit', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const ops = (p: { admissionId: string; policyVersion: string }) => ['identity', 'snapshot', `pause-export ${p.admissionId} ${p.policyVersion} 0 0`, 'quit'];
  for (const [label, extra, over, code] of [
    ['build digest ≠ registration', {}, { build: 'b'.repeat(64) }, 'REGISTRATION_MISMATCH'],
    ['reader physical tuple (database OID) mismatch', {}, { physical: { databaseOid: String(Number(physical.databaseOid) + 1) } }, 'REGISTRATION_MISMATCH'],
    ['first budget exhausted after a bound wrapper (test clock skew)', { skewAfterStartupWrapperMs: 5000 }, {}, 'DEADLINE']] as const) {
    const s = await session('LAUNCH', ops, extra, over);
    try {
      assert.ok(await s.pty.exited(30000), `${label}: session ended`);
      assert.deepEqual(s.pty.results.map(x => x.line), [`FAILURE ${code}`, `FAILURE ${code}`, `FAILURE ${code}`], label);
      await assert.rejects(readFile(s.probes.serverFdProbe, 'utf8'), `${label}: S never started`);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name IN ('atlas-reval-s-runtime', 'atlas-reval-e-owner')`,
        [db.name])).rows[0].n, 0, `${label}: no S or E session`);
    } finally { assert.deepEqual((await s.pty.stop()).forced, [], 'no O/C/S/E process survives the session'); }
  }
});

test('production bridge refuses Ask remote/mock, an env URL, a missing launch frame and a non-launch first frame — before any credential or DB', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const main = `${PROJECT_ROOT}/dist/apps/api/src/main.js`;
  const run = (env: Record<string, string>, send?: Buffer) => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, [main], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: { ATLAS_MODE: 'db', ATLAS_API_PORT: '3999', ATLAS_REVAL_BRIDGE_FD: '3', ...env } });
    const sock = child.stdio[3] as Socket; sock.on('error', () => undefined);
    if (send) sock.once('data', () => sock.write(send));
    const t = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', code => { clearTimeout(t); resolve(code); });
  });
  assert.equal(await run({ ATLAS_ASK_MODE: 'remote' }), 40);
  assert.equal(await run({ ATLAS_ASK_MODE: 'mock' }), 40);
  assert.equal(await run({ ATLAS_RUNTIME_DATABASE_URL: 'postgresql://x:y@127.0.0.1/z' }), 40);
  assert.equal(await run({ ATLAS_OPERATOR_UI: '1' }), 40);
  assert.equal(await run({}), 42, 'no launch frame within 2 s');
  assert.equal(await run({}, encodeFrame({ contractVersion: 'RevalOwnerCommandV1' }, PRIVATE_FRAME_CAP)), 42, 'non-launch frame');
});

test('leak detector self-test: a deliberately inherited extra sentinel IS detected; the helper (unmodified) is inspected externally with lsof', { skip: !darwin && 'darwin/arm64 only' }, async () => {
  const dir = await privateDir('leak');
  const sentinelFd = openSync(`${dir}/sentinel`, 'w'); const st = fstatSync(sentinelFd);
  const probe = `${dir}/probe.json`;
  const script = `const fs=require('fs');const out=[];for(const n of fs.readdirSync('/dev/fd')){try{const s=fs.fstatSync(Number(n));out.push({fd:Number(n),dev:s.dev,ino:s.ino,type:s.isSocket()?'socket':s.isFile()?'file':s.isDirectory()?'dir':'other'})}catch{}}fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify(out))`;
  await new Promise(r => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', sentinelFd] }).on('exit', r));
  const leaked = inherited(JSON.parse(await readFile(probe, 'utf8')), [{ kind: 'sentinel-file', dev: st.dev, ino: st.ino }]);
  assert.equal(leaked.sentinelLeaks, 1, 'the detector catches a deliberately inherited sentinel file (test-only wrapper)');
  const sockListener = createServer(); await new Promise<void>(r => sockListener.listen(0, '127.0.0.1', r));
  const sockFd = (sockListener as unknown as { _handle: { fd: number } })._handle.fd;
  await new Promise(r => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', sockFd] }).on('exit', r));
  assert.equal(inherited(JSON.parse(await readFile(probe, 'utf8')), []).sentinelLeaks, 1, 'an extra inherited socket is caught');
  sockListener.close();
  // The production helper, paused on fd 4 (held open, not yet written): lsof lists exactly its stdio, the channel and fd 4.
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const lfd = (listener as unknown as { _handle: { fd: number } })._handle.fd; const lst = fstatSync(lfd);
  const child = spawn(process.execPath, ['-e', "require('fs').writeSync(3,'x');setTimeout(()=>{},3000)"], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const sock = child.stdio[3] as Socket; await new Promise(r => sock.once('data', r));
  const fd = (sock as unknown as { _handle: { fd: number } })._handle.fd;
  const h = spawn(helper.path, ['peer'], { stdio: ['ignore', 'pipe', 'ignore', fd, 'pipe'], env: {} });
  await new Promise(r => setTimeout(r, 300));
  const lsof = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(h.pid), '-d', '0-64', '-F', 'fi'], { encoding: 'utf8' });
  const fds = [...lsof.matchAll(/^f(\d+)$/gm)].map(m => Number(m[1]));
  assert.deepEqual(fds.sort((a, b) => a - b), [0, 1, 2, 3, 4], lsof);
  for (const ino of [...lsof.matchAll(/^i(\d+)$/gm)].map(m => Number(m[1]))) assert.ok(ino !== st.ino && ino !== lst.ino, 'no sentinel in the helper');
  (h.stdio[4] as NodeJS.WritableStream).end(NODE_REALPATH);
  await new Promise(r => h.on('exit', r)); child.kill(); listener.close();
});
