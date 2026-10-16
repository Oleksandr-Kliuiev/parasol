import { historicalReader } from './support/reval-history.ts';
import { verifyArtifact } from '../scripts/ask-remote-eval-execution/artifact.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The original RC5 verifier must reject the later RS-D-C artifact for its enumerated child deltas,
// and reject the evolving Parasol checkout. Inputs come from the verified historical Reader rather
// than an optional machine-local directory. Positive full-chain verification and isolated source,
// build, overlay and seal tampering are exercised by reval-instrument-identity.test.ts.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha = (p: string) => createHash('sha256').update(historicalReader(p.slice(ROOT.length))!).digest('hex');
/** The authorized RS-A child deltas of pinned R-C entries (brief §10), exact, with their pinned old hashes. */
export const ALLOWED_SOURCE_DELTAS: Readonly<Record<string, string>> = Object.freeze({
  'apps/api/src/main.ts': '278af78d0389619b8801e29c74832dac0db100eada353527725c526c56ce99cc',
  'docs/RUNBOOK.md': '5adc9447bd99a8cab020d02e7a940c7a8446aa9cdd598594bda37902db9a9f4c',
  'packages/graph/runtime-role.ts': '6aac5e454c52de04c27241bd68ff3dc1980428397a37290b7dcbc720324818eb',
  'prisma/askremote.prisma': '39455ebf57c1aff9b958e9d6fa3bff7387b6c56829a8e900a273a71647498619',
  'prisma/roles.sql': '7a9419b37d1d575ad073abf0837850350879ae9b15c018cc6f0c19809b0d3f69',
  'prisma/schema.prisma': 'd4ce4995d9dd4540c51cd3beaa4e1f4ecb04d6362d06cd8692a3a4e3b9052bb5',
  'tests/pg/action-upgrade-s3b.pg.test.ts': 'ba143ca0cbbfc9b08fd060981738801d1f68dde78be9c756193f7de733f33f3b',
  'tests/pg/action-upgrade-s3c.pg.test.ts': '65713bd629406ef3ca5affbb1cd384962dda29f5ce7ea4981f179aa035a4fcd2',
  'tests/pg/ask-remote-upgrade.pg.test.ts': '565dcac053af261714c7e03cf9a6e9e755a6bf3db5a87ea3e9cdd0da3f720906',
  'tests/context-mapper.test.ts': '61575892cc6610c2bb265a6e7180ab7b1fb75edd9ab247d990dba791dd98bfd9',
  'tests/m365-database.test.ts': '944fe27dc99f160c4f6ae4d8ce2583b7404b82d0eecec53761cf0a4c5fc6ec78',
  'tests/support/pg-harness.ts': '5ef48f7e58e314124f1a0db23f1b9a6b09c0238eeaa7cd5cad392e5875bcd56c',
  'tests/support/poweroffice-envelope.ts': '681c4458cd223ed37ce7cdbec2c40f6e189d319665d6ab827fcf47d8a0f4a382',
  'tests/support/roles-sql.ts': 'a88d5a22b75e2bca138ac843d2aeeeb8df8dbc4baae6682c66eb8b3fe1b60693',
});
/**
 * RS-C-A (rs-c/IMPLEMENTATION_BRIEF.md §4): the enumerated evaluation hook points in accepted R-B/R-C product code, with their
 * pinned R-C old hashes. Three of them (budget.ts, remote/db.ts, remote/service.ts) are also execution-RC5 files: the RC5
 * instrument identity is superseded by the RS-C-B instrument revision; no other RC5 file may change.
 */
export const RSCA_SOURCE_DELTAS: Readonly<Record<string, string>> = Object.freeze({
  'apps/api/src/ask-http.ts': '4adde55dcaa04505bd4b438ab1587cdf846e74af97392e0a019389e96351d52b',
  'apps/api/src/db/ask-remote.ts': '62d272d91314bd93e65a4f2ea3c8df60ac92de355f41679880f8ae0c097d762d',
  'packages/ask/budget.ts': '2a2075e3ec2ec5b6842224b9d967173ad1ee0fe3dfd9d0d6abcccdb6ad923c96',
  'packages/ask/remote/db.ts': 'fd7f5b9bee6ff310a1ab16f2daad9f8514ebc97508ecddb0194d8b9cd0e671e3',
  'packages/ask/remote/service.ts': 'a1175ea49e35ef85867c05d46e4b8a83668faa2498ee25177889db0ba2fddf68',
});
export const RSCA_RC5_EXECUTION_DELTAS: readonly string[] = ['packages/ask/budget.ts', 'packages/ask/remote/db.ts', 'packages/ask/remote/service.ts'];
/**
 * RS-C-C (rs-c/IMPLEMENTATION_BRIEF_C.md §1): the measured console build hook and the R-EVAL server routing row of the context map, with
 * their pinned R-C old hashes. The map is also an RC5 administrative overlay: the superseded RC5 guard reports ADMIN_OVERLAY_DRIFT
 * for exactly that path (the instrument revision records it in its candidate layer instead). No other overlay may change.
 */
export const RSCC_SOURCE_DELTAS: Readonly<Record<string, string>> = Object.freeze({
  'docs/AI_CONTEXT_MAP.md': 'ec0ca3515f66126fea7322fef51895fb93e68dfced2bce0acd384e4577006983',
  'scripts/operator-build.ts': '907f03036d1dc9938ac67a8de2d0e830b2d6efe6a1c586e1f1f9a253d1f922bf',
});
export const RSCC_OVERLAY_DELTAS: readonly string[] = ['docs/AI_CONTEXT_MAP.md'];
export const ALLOWED_BUILD_DELTAS: readonly string[] = ['dist/apps/api/src/main.js', 'dist/packages/graph/runtime-role.js', 'dist/apps/api/src/ask-http.js',
  'dist/apps/api/src/db/ask-remote.js', 'dist/packages/ask/budget.js', 'dist/packages/ask/remote/db.js', 'dist/packages/ask/remote/service.js'];
interface Entry { path: string; sha256: string }
const manifest = JSON.parse(readFileSync(join(ROOT, 'verification/stage5/S5ASKREMOTE_RC_RC1_MANIFEST.json'), 'utf8')) as { files: Entry[]; builtInventory: Entry[] };
const overlays = (root: string): Record<string, string> => {
  const art = historicalReader('scripts/ask-remote-eval-execution/artifact.ts')!.toString('utf8');
  return Object.fromEntries([...art.slice(art.indexOf('ADMIN_OVERLAYS'), art.indexOf('ADMIN_PATHS')).matchAll(/'([^']+)':\s*'([0-9a-f]{64})'/g)].map(m => [m[1]!, m[2]!]));
};
const guard = (_root: string) => { const s = verifyArtifact(historicalReader); return { ok: s.ok, drift: s.drift }; };
const drifting = (root: string, list: Entry[]) => { const o = overlays(root); return list.filter(e => {
  const p = join(root, e.path); const cur = historicalReader(e.path) !== null ? sha(p) : 'MISSING';
  return cur !== e.sha256 && !(o[e.path] !== undefined && o[e.path] === cur);
}).map(e => ({ path: e.path, old: e.sha256, now: historicalReader(e.path) !== null ? sha(join(root, e.path)) : 'MISSING' })); };

test('frozen RS-D-C fixture: RC5 guard refuses ONLY for the enumerated authorized child deltas (RS-C-C: one enumerated overlay)', () => {
  const g = guard(ROOT);
  assert.equal(g.ok, false);
  // RS-C-A: its three enumerated Ask hook files are also offline-RC3 package files → OFFLINE_FILE_DRIFT, caused by exactly them.
  assert.deepEqual([...g.drift].sort(), ['ADMIN_OVERLAY_DRIFT', 'OFFLINE_FILE_DRIFT', 'RC_BUILD_DRIFT', 'RC_SOURCE_DRIFT'],
    'no RC_MANIFEST_DRIFT, OFFLINE_PACKAGE_HASH, DATASET_* or *_EMPTY; ADMIN_OVERLAY_DRIFT only for the RS-C-C enumerated overlay (checked below)');
  const offline = JSON.parse(readFileSync(join(ROOT, 'verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_RC3_MANIFEST.json'), 'utf8')) as { files: Entry[] };
  assert.deepEqual(drifting(ROOT, offline.files).map(d => d.path).sort(), [...RSCA_RC5_EXECUTION_DELTAS, ...RSCC_OVERLAY_DELTAS].sort(),
    'offline drift = the RS-C-A hook files + the RS-C-C enumerated map row exactly');
  const src = drifting(ROOT, manifest.files); const build = drifting(ROOT, manifest.builtInventory);
  const allowed = { ...ALLOWED_SOURCE_DELTAS, ...RSCA_SOURCE_DELTAS, ...RSCC_SOURCE_DELTAS };
  assert.deepEqual(src.map(d => d.path).sort(), Object.keys(allowed).sort(), 'source drift = authorized RS-A + RS-C-A + RS-C-C deltas exactly');
  assert.deepEqual(build.map(d => d.path).sort(), [...ALLOWED_BUILD_DELTAS].sort(), 'build drift = rebuilt outputs of authorized deltas exactly');
  for (const d of src) assert.equal(d.old, allowed[d.path], d.path);
  for (const [p, h] of Object.entries(overlays(ROOT))) {
    if (RSCC_OVERLAY_DELTAS.includes(p)) assert.notEqual(sha(join(ROOT, p)), h, `overlay ${p}: the enumerated RS-C-C delta`);
    else assert.equal(sha(join(ROOT, p)), h, `overlay ${p} still at its RC5 pin`);
  }
  for (const d of [...src, ...build]) console.log(`# REVAL_EVIDENCE rc5-child-delta ${d.path} ${d.old} -> ${d.now}`);
  // The 120 frozen RC5 execution files are untouched.
  const rc5 = JSON.parse(readFileSync(join(ROOT, 'verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC5_MANIFEST.json'), 'utf8')) as { files: Entry[] };
  assert.equal(rc5.files.length, 120);
  for (const e of rc5.files) if (!RSCA_RC5_EXECUTION_DELTAS.includes(e.path) && !RSCC_OVERLAY_DELTAS.includes(e.path)) assert.equal(sha(join(ROOT, e.path)), e.sha256, e.path);
  for (const p of RSCA_RC5_EXECUTION_DELTAS) assert.equal(rc5.files.find(e => e.path === p)?.sha256, RSCA_SOURCE_DELTAS[p], `${p}: RC5 pin = R-C pin`);
});

test('the production RC5 guard refuses the current checkout and corrupted pinned anchors', () => {
  const current = verifyArtifact();
  assert.equal(current.ok, false);
  assert.ok(current.drift.includes('RC_SOURCE_DRIFT'));
  assert.ok(current.drift.includes('RC_BUILD_DRIFT'));
  for (const [path, code] of [
    ['verification/stage5/S5ASKREMOTE_RC_RC1_MANIFEST.json', 'RC_MANIFEST_DRIFT'],
    ['verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_RC3_MANIFEST.json', 'OFFLINE_MANIFEST_DRIFT'],
    ['verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_STATUS.json', 'OFFLINE_STATUS_MISMATCH'],
  ]) {
    const changed = verifyArtifact(p => p === path ? Buffer.from('{}') : historicalReader(p));
    assert.equal(changed.ok, false);
    assert.ok(changed.drift.includes(code!), `${path}: ${changed.drift.join(',')}`);
  }
});
