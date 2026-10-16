import { historicalReader } from './support/reval-history.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameIdentity } from '../scripts/ask-remote-eval-execution/artifact.ts';
import { CANDIDATE_SEAL } from '../scripts/reval-instrument/candidate.ts';
import { BUILD_INVENTORY, verifyRevision } from '../scripts/reval-instrument/identity.ts';
import type { Reader } from '../scripts/reval-instrument/identity.ts';

// R-EVAL RS-C-B chained identity (rs-c brief B §2) and the revision's network guard (§1). The identity is checked on the real tree
// and on overlays of single files (an injected reader): a listed source byte, a non-rebuilt built output (incl. the RS-A-pinned
// runtime-role.js, rc2 F1), a seal, an admin overlay and a pinned manifest are drift; an output rebuilt from an accepted RS-B/RS-C-A
// source is recorded (its digest changes), not drift — but it changes the RC5-compatible identity, so a change after start is
// refused by the pre-GO check and by the RC5 session's own pre-submit check (both use `sameIdentity`). RS-D-A: the RS-C-C manifest and
// seal are pinned (its context map and measured console sources are drift; its sealed console build is a recorded rebuilt output);
// the RS-D-A candidate layer is recorded. RS-D-B: RS-D-A is pinned (its context map passes the overlay table only with its accepted
// bytes). RS-D-C (final revision): RS-D-B is pinned, every output rebuilt from an accepted source is pinned by the sealed build
// inventory, and the RS-D-C candidate layer is recorded (accepted exactly when its matching seal exists).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const disk: Reader = historicalReader;
const overlay = (path: string, bytes: Buffer | null): Reader => p => p === path ? bytes : disk(p);
const flip = (path: string): Reader => { const b = Buffer.from(disk(path)!); b[b.length - 1] ^= 1; return overlay(path, b); };

test('chained identity: the frozen RS-D-C fixture verifies; every pinned anchor, seal, source and non-rebuilt output byte is drift', () => {
  const base = verifyRevision(disk);
  assert.equal(base.snapshot.ok, true, base.snapshot.drift.join(','));
  assert.ok(base.revision && base.revision.expectedFiles > 1800);
  for (const [path, code] of [['packages/reval/eval-state.ts', 'SOURCE_DRIFT'], ['packages/ask/remote/service.ts', 'SOURCE_DRIFT'], ['scripts/ask-remote-eval-execution/session.ts', 'SOURCE_DRIFT'],
    ['dist/packages/ask/contracts.js', 'BUILD_DRIFT'], ['dist/packages/graph/runtime-role.js', 'BUILD_DRIFT'], ['dist/packages/reval/channel.js', 'BUILD_DRIFT'],
    ['verification/stage5/S5ASKREMOTE_REVAL_RSCA_APPROVED.json', 'RSCA_SEAL_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_RSA_APPROVED.json', 'RSA_SEAL_DRIFT'],
    ['verification/stage5/S5ASKREMOTE_REVAL_RSA_RC3_MANIFEST.json', 'RSA_MANIFEST_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC5_MANIFEST.json', 'RC5_MANIFEST_DRIFT'], ['AGENTS.md', 'ADMIN_OVERLAY_DRIFT']] as const) {
    const r = verifyRevision(flip(path));
    assert.equal(r.snapshot.ok, false, path); assert.ok(r.snapshot.drift.includes(code), `${path}: ${r.snapshot.drift.join(',')}`);
  }
  assert.ok(verifyRevision(overlay('packages/reval/eval-state.ts', null)).snapshot.drift.includes('SOURCE_DRIFT'), 'a missing file is drift');
  for (const [path, code] of [['verification/stage5/S5ASKREMOTE_REVAL_RSCB_APPROVED.json', 'RSCB_SEAL_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_RSCB_RC3_MANIFEST.json', 'RSCB_MANIFEST_DRIFT'],
    ['scripts/reval-instrument/ledger.ts', 'SOURCE_DRIFT'], ['tests/reval-instrument-units.test.ts', 'SOURCE_DRIFT']] as const) {
    assert.ok(verifyRevision(flip(path)).snapshot.drift.includes(code), `RS-C-B pinned: ${path}`);
  }
  // RS-D-A: RS-C-C is pinned — its seal/manifest and its measured console sources/build script are drift; its sealed console build is
  // rebuilt from accepted sources (recorded). (Its context map change is superseded by RS-D-A's candidate layer.)
  for (const [path, code] of [['verification/stage5/S5ASKREMOTE_REVAL_RSCC_APPROVED.json', 'RSCC_SEAL_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_RSCC_RC2_MANIFEST.json', 'RSCC_MANIFEST_DRIFT'],
    ['apps/operator/measured/eval-controller.ts', 'SOURCE_DRIFT'], ['scripts/operator-measured-build.ts', 'SOURCE_DRIFT'], ['tests/reval-measured-build.test.ts', 'SOURCE_DRIFT']] as const) {
    assert.ok(verifyRevision(flip(path)).snapshot.drift.includes(code), `RS-C-C pinned: ${path} ${code}`);
  }
  // RS-D-C: the sealed measured console build (like every output rebuilt from an accepted source) is PINNED by the build inventory.
  assert.ok(verifyRevision(flip('dist/operator-measured/manifest.json')).snapshot.drift.includes('BUILD_DRIFT'), 'the sealed console build is pinned');
  // RS-D-B: RS-D-A is pinned — its seal/manifest, its census modules, its brief and the context map (an RC5 overlay last changed by
  // the accepted RS-D-A: equal to its pinned bytes it passes, any other bytes are SOURCE and ADMIN_OVERLAY drift).
  for (const [path, code] of [['verification/stage5/S5ASKREMOTE_REVAL_RSDA_APPROVED.json', 'RSDA_SEAL_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_RSDA_RC2_MANIFEST.json', 'RSDA_MANIFEST_DRIFT'],
    ['packages/reval/eval-census.ts', 'SOURCE_DRIFT'], ['scripts/reval-instrument/census.ts', 'SOURCE_DRIFT'], ['docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_A.md', 'SOURCE_DRIFT'],
    ['docs/AI_CONTEXT_MAP.md', 'SOURCE_DRIFT'], ['docs/AI_CONTEXT_MAP.md', 'ADMIN_OVERLAY_DRIFT']] as const) {
    assert.ok(verifyRevision(flip(path)).snapshot.drift.includes(code), `RS-D-A pinned: ${path} ${code}`);
  }
  // RS-D-C: RS-D-B is pinned — its seal/manifest, its drain/IPC/helper sources and its brief.
  for (const [path, code] of [['verification/stage5/S5ASKREMOTE_REVAL_RSDB_APPROVED.json', 'RSDB_SEAL_DRIFT'], ['verification/stage5/S5ASKREMOTE_REVAL_RSDB_RC2_MANIFEST.json', 'RSDB_MANIFEST_DRIFT'],
    ['packages/reval/eval-drain.ts', 'SOURCE_DRIFT'], ['scripts/reval-instrument/ipc.ts', 'SOURCE_DRIFT'], ['native/reval-peer/peer.c', 'SOURCE_DRIFT'],
    ['docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_B.md', 'SOURCE_DRIFT']] as const) {
    assert.ok(verifyRevision(flip(path)).snapshot.drift.includes(code), `RS-D-B pinned: ${path} ${code}`);
  }
  // RS-D-C sealed build inventory: every output rebuilt from an accepted RS-B … RS-D-B source is pinned (any byte → BUILD_DRIFT); the
  // inventory must list exactly that set, sorted, closed schema (else BUILD_INVENTORY_MISMATCH).
  for (const path of ['dist/packages/reval/eval-drain.js', 'dist/packages/reval/eval-state.js', 'dist/apps/api/src/reval/bridge.js']) {
    const r = verifyRevision(flip(path)); assert.ok(r.snapshot.drift.includes('BUILD_DRIFT'), `${path}: ${r.snapshot.drift.join(',')}`);
  }
  assert.ok(verifyRevision(overlay('dist/packages/reval/eval-drain.js', null)).snapshot.drift.includes('BUILD_DRIFT'), 'a missing pinned output');
  const inv = JSON.parse(disk(BUILD_INVENTORY)!.toString('utf8')) as { contractVersion: string; outputs: { path: string; sha256: string }[] };
  assert.ok(inv.outputs.length > 40 && inv.outputs.some(o => o.path === 'dist/operator-measured/manifest.json'));
  const withInventory = (o: unknown): Reader => overlay(BUILD_INVENTORY, Buffer.from(JSON.stringify(o)));
  assert.equal(verifyRevision(withInventory(inv)).snapshot.drift.includes('BUILD_INVENTORY_MISMATCH'), false, 'the same content, other spacing: valid');
  for (const [why, o] of [['an output missing', { ...inv, outputs: inv.outputs.slice(1) }], ['an extra output', { ...inv, outputs: [...inv.outputs, { path: 'dist/zz.js', sha256: 'a'.repeat(64) }] }],
    ['unsorted', { ...inv, outputs: [...inv.outputs].reverse() }], ['a duplicate', { ...inv, outputs: [inv.outputs[0], ...inv.outputs] }],
    ['another contract', { ...inv, contractVersion: 'X' }], ['an extra key', { ...inv, note: 1 }], ['a bad digest', { ...inv, outputs: inv.outputs.map((e, i) => i ? e : { ...e, sha256: 'x' }) }]] as const) {
    assert.ok(verifyRevision(withInventory(o)).snapshot.drift.includes('BUILD_INVENTORY_MISMATCH'), why);
  }
  const wrong = verifyRevision(withInventory({ ...inv, outputs: inv.outputs.map((e, i) => i ? e : { ...e, sha256: 'b'.repeat(64) }) }));
  assert.ok(wrong.snapshot.drift.includes('BUILD_DRIFT'), 'an inventory hash that the output does not have');
  assert.ok(verifyRevision(overlay(BUILD_INVENTORY, null)).snapshot.drift.includes('BUILD_INVENTORY_MISMATCH'), 'no inventory');
  // RS-D-C candidate layer, seal-aware (RS-D-B knownPostSealTestState; rc2 F2): the recorded-layer behaviour is asserted on a view WITHOUT
  // the part's seal and the sealed behaviour on a view with a simulated matching seal — both run whatever is on disk, before and after.
  assert.equal(base.revision!.candidate.accepted, disk(CANDIDATE_SEAL) !== null, 'accepted exactly when the part\'s (matching) seal exists');
  const on = (r: Reader, path: string, bytes: Buffer | null): Reader => p => p === path ? bytes : r(p);
  const flipOn = (r: Reader, path: string): Reader => { const b = Buffer.from(r(path)!); b[b.length - 1] ^= 1; return on(r, path, b); };
  const unsealed = on(disk, CANDIDATE_SEAL, null); const open = verifyRevision(unsealed);
  assert.deepEqual([open.snapshot.ok, open.revision!.candidate.accepted], [true, false]);
  for (const path of ['scripts/reval-instrument/identity.ts', 'scripts/reval-instrument/build-inventory.ts']) {
    const c = verifyRevision(flipOn(unsealed, path));
    assert.equal(c.snapshot.ok, true, path);
    assert.notEqual(c.revision!.candidate.sha256, open.revision!.candidate.sha256, path);
    assert.equal(sameIdentity(open.snapshot, c.snapshot), false, `${path}: a candidate change after start is refused before GO / at submit`);
  }
  assert.ok(verifyRevision(on(unsealed, 'scripts/reval-instrument/build-inventory.ts', null)).snapshot.drift.includes('CANDIDATE_MISSING'));
  const sealed = (candidateSha256: string, status = 'ACCEPTED_RS_D_C_RC1'): Reader => on(unsealed, CANDIDATE_SEAL, Buffer.from(JSON.stringify({ status, candidateSha256 })));
  const accepted = verifyRevision(sealed(open.revision!.candidate.sha256));
  assert.deepEqual([accepted.snapshot.ok, accepted.revision!.candidate.accepted], [true, true]);
  for (const r of [sealed('0'.repeat(64)), sealed(open.revision!.candidate.sha256, 'DRAFT')]) assert.ok(verifyRevision(r).snapshot.drift.includes('CANDIDATE_SEAL_MISMATCH'));
  for (const path of ['scripts/reval-instrument/identity.ts', 'scripts/reval-instrument/build-inventory.ts']) { // after acceptance: only the accepted bytes run
    const c = verifyRevision(flipOn(sealed(open.revision!.candidate.sha256), path));
    assert.deepEqual([c.snapshot.ok, c.snapshot.drift.includes('CANDIDATE_SEAL_MISMATCH')], [false, true], `${path} under the seal`);
  }
  assert.equal(sameIdentity(base.snapshot, verifyRevision(disk).snapshot), true, 'an unchanged tree keeps the identity');
});

test('revision network guard: only the two named unix sockets, named once; TCP, fetch, DNS and other paths are blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reval-guard-'));
  const script = join(dir, 'probe.ts');
  writeFileSync(script, `
import { allowUnixSockets, installInstrumentGuard } from ${JSON.stringify(join(ROOT, 'scripts/reval-instrument/net-guard.ts'))};
import net from 'node:net'; import dns from 'node:dns'; import { join } from 'node:path';
const dir = ${JSON.stringify(dir)}; const ok = join(dir, 'a.sock'); const other = join(dir, 'b.sock');
const server = net.createServer(s => s.end()); await new Promise(r => server.listen(ok, r));
const otherServer = net.createServer(s => s.end()); await new Promise(r => otherServer.listen(other, r));
installInstrumentGuard();
const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code ?? 'ERR'; } };
const out = {
  beforeAllow: code(() => net.createConnection(ok).destroy()),
  fetch: code(() => fetch('http://127.0.0.1:1')),
  tcp: code(() => net.createConnection({ host: '127.0.0.1', port: 1 })),
  dns: code(() => dns.lookup('localhost', () => undefined)),
  resolver: code(() => new dns.Resolver()), promiseResolver: code(() => new dns.promises.Resolver()),
  relative: code(() => allowUnixSockets(['a.sock', 'b.sock'])),
};
allowUnixSockets([ok, join(dir, 'c.sock')]);
out.allowed = code(() => net.createConnection(ok).destroy());
out.otherPath = code(() => net.createConnection(other));
out.socketConnect = code(() => new net.Socket().connect(other));
out.second = code(() => allowUnixSockets([ok, other]));
console.log(JSON.stringify(out)); server.close(); otherServer.close(); process.exit(0);
`);
  const out = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { encoding: 'utf8' }).trim().split('\n').pop()!);
  assert.deepEqual(out, { beforeAllow: 'INSTRUMENT_EGRESS_BLOCKED', fetch: 'INSTRUMENT_EGRESS_BLOCKED', tcp: 'INSTRUMENT_EGRESS_BLOCKED', dns: 'INSTRUMENT_EGRESS_BLOCKED',
    resolver: 'INSTRUMENT_EGRESS_BLOCKED', promiseResolver: 'INSTRUMENT_EGRESS_BLOCKED',
    relative: 'INSTRUMENT_EGRESS_BLOCKED', allowed: 'OK', otherPath: 'INSTRUMENT_EGRESS_BLOCKED', socketConnect: 'INSTRUMENT_EGRESS_BLOCKED', second: 'INSTRUMENT_EGRESS_BLOCKED' });
});

test('production instrument CLI rejects current drift and arms raw mode before dynamic imports', () => {
  const source = readFileSync(join(ROOT, 'scripts/reval-instrument/cli.ts'), 'utf8');
  assert.ok(source.indexOf('process.stdin.setRawMode(true)') < source.indexOf('await import('));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts/reval-instrument/cli.ts'), 'artifact-check'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false); assert.equal(output.liveAcceptanceEligible, false);
  assert.ok(output.drift.length > 0);
});
