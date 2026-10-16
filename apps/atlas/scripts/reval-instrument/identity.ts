// Chained artifact identity of the R-EVAL instrument revision (rs-c/IMPLEMENTATION_BRIEF_B.md §2). The accepted RC5 identity
// (scripts/ask-remote-eval-execution/artifact.ts, unchanged) pins the offline RC3 and R-C RC1 manifests only, so it refuses every
// tree after the accepted RS-A/RS-C-A deltas. This revision pins those two manifests PLUS the RC5 execution manifest (the 120 files
// it imports), the accepted RS-A rc3 manifest + seal and the RS-B rc2 and RS-C-A rc2 manifests + seals, builds ONE expected
// path → sha256 map in acceptance order (R-C sources, R-C built inventory, RC5, RS-A — whose `dist/` pins supersede R-C's —,
// RS-B, RS-C-A, then the seals' administrative deltas) and re-hashes every listed file. The RC5 admin overlays keep their exact
// pinned current hashes. Only the built outputs of `apps|packages` sources changed/added by the accepted RS-B/RS-C-A packages are
// RECORDED (presence + digest), never pinned (rc2 F1); every other expected path, built or source, must match exactly. The
// recorded digest is folded into `Identity.executionToolSha256`, so the RC5 session's own pre-submit check and the revision's
// pre-GO check (`sameIdentity`) both refuse a rebuilt output that changed after start. The result is an RC5-compatible
// Snapshot (same Identity keys). RS-C-C: the RS-C-B rc3 manifest + seal are pinned too. RS-D-A: the RS-C-C rc2 manifest + seal are
// pinned as well (their sealed measured console build `dist/operator-measured/manifest.json` is a rebuilt output: recorded), and the
// enumerated candidate layer (candidate.ts) is RECORDED. RS-D-B: the RS-D-A rc2 manifest + seal are pinned too and the RS-D-B
// candidate layer is recorded — its digest is folded into the identity and, once the RS-D-B seal exists, must equal the seal's.
// RS-D-C (final revision): the RS-D-B rc2 manifest + seal are pinned too, and the built outputs of every accepted RS-B … RS-D-B source
// are PINNED by the sealed build inventory (S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json, an RS-D-C candidate path) instead of only
// recorded: any byte difference is BUILD_DRIFT. Nothing here proves what a RUNNING server process loaded (UNVERIFIED).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { flattenCorpus, loadCorpusFiles, MANIFEST_FILE, ORDER_SEED, readData, stableOrder } from '../ask-remote-eval/dataset.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import { datasetManifest } from '../ask-remote-eval/evidence.ts';
import { ADMIN_OVERLAYS, ADMIN_PATHS, adminOverlaySha256, executionToolSha256 as rc5ToolSha256, OFFLINE_MANIFEST, OFFLINE_STATUS, overlayDrift, RC_MANIFEST }
  from '../ask-remote-eval-execution/artifact.ts';
import type { Identity, Snapshot } from '../ask-remote-eval-execution/artifact.ts';
import { CANDIDATE_ID, CANDIDATE_PATHS, CANDIDATE_SEAL, CANDIDATE_SEAL_STATUS } from './candidate.ts';

const ROOT = new URL('../../', import.meta.url);
const TOOL_DIR = new URL('./', import.meta.url);
interface Anchor { readonly path: string; readonly sha256: string }
/** Accepted anchors, in acceptance order after the two RC5 anchors. Each seal must name its manifest and accepted status. */
export const ANCHORS = Object.freeze({
  /** The RC5 execution instrument this revision imports (its 120 files; its own acceptance stays a separate gate). */
  rc5Manifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC5_MANIFEST.json', sha256: 'bf13e43f96c7c990d60f715ad60ddc7b101df8aab5ce23406c267e0d3e979fc3' },
  rsaManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSA_RC3_MANIFEST.json', sha256: 'a356a7d1a45ac704df0a875bb69ea92161e5c085556d86d4514cf0f9e55f862c' },
  rsaSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSA_APPROVED.json', sha256: 'e89a4c0830628e3aa86c376c36908b353bab450a63ac870c53f55b982fe42bf9' },
  rsbManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSB_RC2_MANIFEST.json', sha256: 'b0643fb69ac6bd46d3ee40d82237835233b607038dde940e2967ecc968cc4534' },
  rsbSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSB_APPROVED.json', sha256: 'b5f51e7716be3d42f32754079877e36542bffdea5dfd743f448570786de07b31' },
  rscaManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCA_RC2_MANIFEST.json', sha256: '8f33b6363c0cf2be4abe6ee791ba92b651d6446c770f3d71bbda27b38d9e8b1b' },
  rscaSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCA_APPROVED.json', sha256: '7e52aae0ce8881f4432462697e899281b4befa2ae87fbe84d69eb15d8ce91afd' },
  rscbManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCB_RC3_MANIFEST.json', sha256: 'f74970284ebfedf37f8e240dc14b11c72f60f974eb8db494fddbe4e077d77929' },
  rscbSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCB_APPROVED.json', sha256: 'db29082cd39e3c75749c8746f876b91c9b3fc163f79f658137cc3233f377b4cf' },
  rsccManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCC_RC2_MANIFEST.json', sha256: 'ecc2030a29c4ddf8ecd8338e9a64547e9c7112cbfe65707ae0a5de9703feb0c1' },
  rsccSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSCC_APPROVED.json', sha256: 'ebba81bd072772346ded1baa9c384231b5189124a7621913434f7d10e4bc3a9c' },
  rsdaManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSDA_RC2_MANIFEST.json', sha256: '38361d6bb4e78c917e75c555772e56f65310903a42efbbea4539c1e73fec2fbf' },
  rsdaSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSDA_APPROVED.json', sha256: '5e0de7a81950b5cbf0a05d5cacc5a28dc19beecfc2a5ef05e9c1921bdfbfb406' },
  rsdbManifest: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSDB_RC2_MANIFEST.json', sha256: '45d5df367b2510aea79b0cccf2fa62878ab167cdd358d3a5e877f70486bc14e0' },
  rsdbSeal: { path: 'verification/stage5/S5ASKREMOTE_REVAL_RSDB_APPROVED.json', sha256: 'dc4dd7fe10a1ed7b8ddc55391925fabf766587086ca97db88c36718fbcb94b03' },
} satisfies Record<string, Anchor>);
const SEAL_STATUS = { rsbSeal: 'ACCEPTED_RS_B_RC2', rscaSeal: 'ACCEPTED_RS_C_A_RC2', rscbSeal: 'ACCEPTED_RS_C_B_RC3', rsccSeal: 'ACCEPTED_RS_C_C_RC2',
  rsdaSeal: 'ACCEPTED_RS_D_A_RC2', rsdbSeal: 'ACCEPTED_RS_D_B_RC2' } as const;
/** RS-D-C: the sealed inventory of the outputs built from accepted RS-B … RS-D-B sources (generated by build-inventory.ts). */
export const BUILD_INVENTORY = 'verification/stage5/S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json';
export const BUILD_INVENTORY_V1 = 'RevalBuildInventoryV1';
/** The sealed measured console build of the accepted RS-C-C sources (its manifest covers every asset): a rebuilt output. */
const MEASURED_CONSOLE_MANIFEST = 'dist/operator-measured/manifest.json';

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export type Reader = (path: string) => Buffer | null;
const diskReader: Reader = path => { try { return readFileSync(new URL(path, ROOT)); } catch { return null; } };
interface Entry { readonly path: string; readonly sha256: string }
const entries = (v: unknown): Entry[] => Array.isArray(v) && v.every(e => e !== null && typeof e === 'object' && typeof e.path === 'string'
  && typeof e.sha256 === 'string') ? v as Entry[] : [];

export interface CandidateRecord { readonly id: string; readonly sha256: string; readonly accepted: boolean }
export interface RevisionRecord {
  readonly anchors: Readonly<Record<string, string>>; readonly instrumentRevisionSha256: string; readonly rc5ToolSha256: string;
  readonly rebuiltOutputsSha256: string; readonly expectedFiles: number; readonly candidate: CandidateRecord;
}
export interface RevisionSnapshot { readonly snapshot: Snapshot; readonly revision: RevisionRecord | null }

/** Hash of this revision's own files (sorted names; `.ts` and AGENTS.md only) — recorded, not pinned. */
export function instrumentRevisionSha256(): string {
  const names = readdirSync(TOOL_DIR).filter(n => n.endsWith('.ts') || n === 'AGENTS.md').sort();
  return sha(names.map(n => `${n}:${sha(readFileSync(new URL(n, TOOL_DIR)))}`).join('\n'));
}

/** The candidate paths plus the built outputs of their apps/api|packages sources (apps/operator/measured compiles into the flat
 *  measured console build, covered by its manifest — no per-file dist/ path; RS-C-C rc2 F5). */
export function candidateSet(paths: readonly string[]): Set<string> {
  const set = new Set<string>(paths);
  for (const p of paths) if (/^(apps\/api|packages)\/.+\.ts$/.test(p)) set.add(`dist/${p.replace(/\.ts$/, '.js')}`);
  return set;
}
/**
 * The outputs rebuilt from the accepted packages' `apps/api|packages` sources (and the sealed measured console manifest once RS-C-C is
 * accepted), minus the outputs of the current candidate layer (recorded there instead).
 */
export function buildOutputPaths(accepted: readonly (Record<string, unknown> | null)[], candidate: ReadonlySet<string>): string[] {
  const set = new Set<string>();
  for (const m of accepted) for (const e of m ? [...entries(m.changed), ...entries(m.added)] : []) {
    if (/^(apps\/api|packages)\/.+\.ts$/.test(e.path)) set.add(`dist/${e.path.replace(/\.ts$/, '.js')}`);
  }
  if (accepted[3]) set.add(MEASURED_CONSOLE_MANIFEST); // RS-C-C
  return [...set].filter(p => !candidate.has(p)).sort();
}
/** The exact build inventory (`{contractVersion, outputs:[{path,sha256}]}`, sorted, no duplicates) as path → sha256, or null. */
export function buildInventory(bytes: Buffer | null): Map<string, string> | null {
  if (bytes === null) return null;
  try {
    const o = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (Object.keys(o).sort().join(',') !== 'contractVersion,outputs' || o.contractVersion !== BUILD_INVENTORY_V1 || !Array.isArray(o.outputs)) return null;
    const list = entries(o.outputs);
    if (list.length !== o.outputs.length || list.some(e => Object.keys(e).length !== 2 || !/^dist\/[A-Za-z0-9._/-]+$/.test(e.path) || !/^[0-9a-f]{64}$/.test(e.sha256))) return null;
    const paths = list.map(e => e.path);
    if (paths.some((p, i) => i > 0 && paths[i - 1]! >= p)) return null; // sorted, unique
    return new Map(list.map(e => [e.path, e.sha256]));
  } catch { return null; }
}

/** The chained verification. `read` defaults to the repository; tests overlay bytes. Never throws. */
export function verifyRevision(read: Reader = diskReader): RevisionSnapshot {
  const drift: string[] = []; const admin = new Set<string>(); let filesChecked = 0;
  const fileSha = (p: string): string | null => { const b = read(p); return b === null ? null : sha(b); };
  const pinned = (a: Anchor, code: string): Record<string, unknown> | null => {
    const b = read(a.path);
    if (b === null || sha(b) !== a.sha256) { drift.push(code); return null; }
    try { return JSON.parse(b.toString('utf8')) as Record<string, unknown>; } catch { drift.push(code); return null; }
  };
  const offline = pinned(OFFLINE_MANIFEST, 'OFFLINE_MANIFEST_DRIFT'); const rc = pinned(RC_MANIFEST, 'RC_MANIFEST_DRIFT');
  const rc5 = pinned(ANCHORS.rc5Manifest, 'RC5_MANIFEST_DRIFT');
  const rsa = pinned(ANCHORS.rsaManifest, 'RSA_MANIFEST_DRIFT'); const rsaSeal = pinned(ANCHORS.rsaSeal, 'RSA_SEAL_DRIFT');
  const rsb = pinned(ANCHORS.rsbManifest, 'RSB_MANIFEST_DRIFT');
  const rsbSeal = pinned(ANCHORS.rsbSeal, 'RSB_SEAL_DRIFT'); const rsca = pinned(ANCHORS.rscaManifest, 'RSCA_MANIFEST_DRIFT');
  const rscaSeal = pinned(ANCHORS.rscaSeal, 'RSCA_SEAL_DRIFT');
  const rscb = pinned(ANCHORS.rscbManifest, 'RSCB_MANIFEST_DRIFT'); const rscbSeal = pinned(ANCHORS.rscbSeal, 'RSCB_SEAL_DRIFT');
  const rscc = pinned(ANCHORS.rsccManifest, 'RSCC_MANIFEST_DRIFT'); const rsccSeal = pinned(ANCHORS.rsccSeal, 'RSCC_SEAL_DRIFT');
  const rsda = pinned(ANCHORS.rsdaManifest, 'RSDA_MANIFEST_DRIFT'); const rsdaSeal = pinned(ANCHORS.rsdaSeal, 'RSDA_SEAL_DRIFT');
  const rsdb = pinned(ANCHORS.rsdbManifest, 'RSDB_MANIFEST_DRIFT'); const rsdbSeal = pinned(ANCHORS.rsdbSeal, 'RSDB_SEAL_DRIFT');
  for (const [seal, manifest, key] of [[rsbSeal, ANCHORS.rsbManifest, 'rsbSeal'], [rscaSeal, ANCHORS.rscaManifest, 'rscaSeal'], [rscbSeal, ANCHORS.rscbManifest, 'rscbSeal'],
    [rsccSeal, ANCHORS.rsccManifest, 'rsccSeal'], [rsdaSeal, ANCHORS.rsdaManifest, 'rsdaSeal'], [rsdbSeal, ANCHORS.rsdbManifest, 'rsdbSeal']] as const) {
    const m = seal?.manifest as { path?: unknown; sha256?: unknown } | undefined;
    if (seal && (seal.status !== SEAL_STATUS[key] || m?.path !== manifest.path || m?.sha256 !== manifest.sha256)) drift.push('SEAL_MISMATCH');
  }
  // The RS-A seal names its manifest by path + manifestSha256 (rc2 F5).
  if (rsaSeal && (rsaSeal.status !== 'DUAL_APPROVED_RS_A' || rsaSeal.manifest !== ANCHORS.rsaManifest.path || rsaSeal.manifestSha256 !== ANCHORS.rsaManifest.sha256)) {
    drift.push('SEAL_MISMATCH');
  }
  if (offline) {
    const files = entries(offline.files);
    if (sha(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) !== offline.packageHash) drift.push('OFFLINE_PACKAGE_HASH');
  }
  // Expected source map in acceptance order (later entries supersede).
  const expected = new Map<string, string>();
  const put = (list: readonly Entry[], code: string) => { if (list.length === 0) drift.push(`${code}_EMPTY`); for (const e of list) expected.set(e.path, e.sha256); };
  const deltas = (seal: Record<string, unknown> | null) => {
    for (const d of (Array.isArray(seal?.administrativeDeltasAfterAcceptance) ? seal!.administrativeDeltasAfterAcceptance as { path?: unknown; to?: unknown }[] : [])) {
      if (typeof d.path === 'string' && typeof d.to === 'string') expected.set(d.path, d.to); else drift.push('SEAL_DELTA_INVALID');
    }
  };
  if (offline) put(entries(offline.files), 'OFFLINE_FILES');
  if (rc) { put(entries(rc.files), 'RC_FILES'); put(entries(rc.builtInventory), 'RC_BUILT'); }
  if (rc5) put(entries(rc5.files), 'RC5_FILES');
  if (rsa) put(entries(rsa.files), 'RSA_FILES');
  if (rsb) { put([...entries(rsb.changed), ...entries(rsb.added)], 'RSB_FILES'); deltas(rsbSeal); }
  if (rsca) { put([...entries(rsca.changed), ...entries(rsca.added)], 'RSCA_FILES'); deltas(rscaSeal); }
  if (rscb) { put([...entries(rscb.changed), ...entries(rscb.added)], 'RSCB_FILES'); deltas(rscbSeal); }
  if (rscc) { put([...entries(rscc.changed), ...entries(rscc.added)], 'RSCC_FILES'); deltas(rsccSeal); }
  if (rsda) { put([...entries(rsda.changed), ...entries(rsda.added)], 'RSDA_FILES'); deltas(rsdaSeal); }
  if (rsdb) { put([...entries(rsdb.changed), ...entries(rsdb.added)], 'RSDB_FILES'); deltas(rsdbSeal); }
  // RS-D-C candidate layer: recorded, not pinned (and its built outputs: those of its apps/api|packages sources).
  const candidate = candidateSet(CANDIDATE_PATHS);
  // RC5's pinned overlay table still applies, except to a candidate path (recorded instead) and to an overlay that a later ACCEPTED
  // package changed (the context map, last by RS-D-A): its current bytes must equal that package's pinned hash (also checked below).
  const acceptedLater = new Set([rscc, rsda, rsdb].flatMap(m => m ? [...entries(m.changed), ...entries(m.added)].map(e => e.path) : []));
  const overlayActual = (p: string): string | null => candidate.has(p) || (acceptedLater.has(p) && fileSha(p) === expected.get(p)) ? ADMIN_OVERLAYS[p] ?? null : fileSha(p);
  if (overlayDrift(ADMIN_OVERLAYS, overlayActual).length > 0) drift.push('ADMIN_OVERLAY_DRIFT');
  // Built outputs of sources changed/added by the accepted RS-B … RS-D-B packages are rebuilt from those accepted sources. RS-D-C: they
  // are PINNED by the sealed build inventory (exactly this set minus RS-D-C candidate outputs; BUILD_INVENTORY_MISMATCH otherwise) and
  // still folded into the recorded digest. apps/operator/measured compiles into the flat measured console build, pinned through its
  // manifest (no per-file dist/ path). Every other expected path — built or source — must match exactly.
  const rebuiltSet = new Set<string>(buildOutputPaths([rsb, rsca, rscb, rscc, rsda, rsdb], candidate));
  const inventory = buildInventory(read(BUILD_INVENTORY));
  const flag = (code: string) => { if (!drift.includes(code)) drift.push(code); };
  if (inventory === null || inventory.size !== rebuiltSet.size || [...rebuiltSet].some(p => !inventory.has(p))) flag('BUILD_INVENTORY_MISMATCH');
  for (const path of rebuiltSet) {
    filesChecked += 1;
    const want = inventory?.get(path);
    if (want === undefined || fileSha(path) !== want) flag('BUILD_DRIFT');
  }
  const rebuilt: string[] = [];
  for (const [path, want] of expected) {
    filesChecked += 1;
    const now = fileSha(path); const built = path.startsWith('dist/');
    if (rebuiltSet.has(path) || candidate.has(path)) { if (now === null) flag(candidate.has(path) ? 'CANDIDATE_MISSING' : 'BUILD_DRIFT'); continue; }
    if (now === want) continue;
    // RC5 rule: a historical mismatch is tolerated ONLY on a declared overlay whose current bytes equal its pinned hash.
    if (ADMIN_PATHS.includes(path) && now === ADMIN_OVERLAYS[path]) admin.add(path); else flag(built ? 'BUILD_DRIFT' : 'SOURCE_DRIFT');
  }
  // The recorded digest covers EVERY output rebuilt from accepted RS-B/RS-C-A sources (new modules included), present or not.
  for (const path of [...rebuiltSet].sort()) rebuilt.push(`${path}:${fileSha(path) ?? 'MISSING'}`);
  const candidateLines: string[] = [];
  for (const path of [...candidate].sort()) {
    const h = fileSha(path);
    if (h === null && CANDIDATE_PATHS.includes(path)) flag('CANDIDATE_MISSING');
    candidateLines.push(`${path}:${h ?? 'MISSING'}`);
  }
  const candidateSha = sha(candidateLines.join('\n'));
  // After acceptance the seal names the accepted candidate digest: any other bytes are drift.
  let candidateAccepted = false;
  const sealBytes = read(CANDIDATE_SEAL);
  if (sealBytes !== null) {
    let seal: Record<string, unknown> | null = null;
    try { seal = JSON.parse(sealBytes.toString('utf8')) as Record<string, unknown>; } catch { seal = null; }
    if (seal === null || typeof seal.status !== 'string' || !CANDIDATE_SEAL_STATUS.test(seal.status) || seal.candidateSha256 !== candidateSha) flag('CANDIDATE_SEAL_MISMATCH');
    else candidateAccepted = true;
  }
  let status: Record<string, unknown> = {};
  try { status = JSON.parse((read(OFFLINE_STATUS) ?? Buffer.from('')).toString('utf8')) as Record<string, unknown>; } catch { drift.push('OFFLINE_STATUS_UNREADABLE'); }
  if (status.status !== 'APPROVED_OFFLINE_PACKAGE' || !offline || status.packageHash !== offline.packageHash || status.manifest !== OFFLINE_MANIFEST.path
    || status.dataAdmission !== 'NOT_ADMITTED' || status.paidProductCalls !== 0) drift.push('OFFLINE_STATUS_MISMATCH');
  interface DatasetInfo { corpusSha256: string; fixtures: { sha256: string }; orderSha256: string; labelStatus: string; attestation: string }
  let dataset = null as DatasetInfo | null;
  try {
    const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
    const derived = datasetManifest(cases) as unknown as DatasetInfo;
    const committed = JSON.parse(readData(MANIFEST_FILE).toString('utf8')) as unknown;
    if (JSON.stringify(committed) !== JSON.stringify(derived) || stableOrder(cases.map(c => c.caseId)).orderSha256 !== derived.orderSha256 || cases.length !== 200) {
      drift.push('DATASET_MANIFEST_MISMATCH');
    } else dataset = derived;
  } catch { drift.push('DATASET_UNREADABLE'); }
  const group = (paths: readonly string[]): string => sha(paths.map(p => `${p}:${fileSha(p) ?? 'MISSING'}`).join('\n'));
  const revisionSha = instrumentRevisionSha256(); const rc5Sha = rc5ToolSha256(); const rebuiltSha = sha(rebuilt.sort().join('\n'));
  const ok = drift.length === 0 && !!(offline && rc && rc5 && rsa && rsaSeal && rsb && rsca && rscb && rscbSeal && rscc && rsccSeal && rsda && rsdaSeal && rsdb && rsdbSeal
    && dataset);
  const identity: Identity | null = offline && rc && dataset ? {
    offlinePackageHash: String(offline.packageHash), offlineManifestSha256: OFFLINE_MANIFEST.sha256, rcPackageHash: String(rc.packageHash),
    rcManifestSha256: RC_MANIFEST.sha256, datasetCorpusSha256: dataset.corpusSha256, fixtureSha256: dataset.fixtures.sha256, orderSha256: dataset.orderSha256,
    orderSeed: ORDER_SEED, executionToolSha256: sha(`rc5:${rc5Sha}\nrevision:${revisionSha}\nrebuilt:${rebuiltSha}\ncandidate:${candidateSha}`),
    comparatorSha256: group(['scripts/ask-remote-eval/predicates.ts', 'scripts/ask-remote-eval/expected-facts.ts', 'scripts/ask-remote-eval/fixtures.ts']),
    browserValidatorSha256: group(['apps/operator/src/validate-ask.ts', 'apps/operator/src/validate-ask-facts.ts', 'apps/operator/src/validate-core.ts', 'apps/operator/src/ask-contracts.ts']),
    projectionSha256: group(['packages/ask/remote/answer.ts', 'packages/ask/compiler.ts', 'packages/ask/selector.ts', 'packages/ask/projection.ts', 'packages/ask/planner.ts']),
    adminOverlaySha256: adminOverlaySha256(),
  } : null;
  const snapshot: Snapshot = { ok: ok && identity !== null, drift, adminDeltaPaths: [...admin].sort(), identity, filesChecked,
    labelStatus: dataset?.labelStatus ?? 'UNKNOWN', attestation: dataset?.attestation ?? 'UNKNOWN' };
  const revision: RevisionRecord | null = snapshot.ok ? { anchors: Object.freeze(Object.fromEntries(Object.entries(ANCHORS).map(([k, a]) => [k, a.sha256]))),
    instrumentRevisionSha256: revisionSha, rc5ToolSha256: rc5Sha, rebuiltOutputsSha256: rebuiltSha, expectedFiles: expected.size,
    candidate: Object.freeze({ id: CANDIDATE_ID, sha256: candidateSha, accepted: candidateAccepted }) } : null;
  return { snapshot, revision };
}
