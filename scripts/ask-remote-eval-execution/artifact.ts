// Immutable artifact identity of the R-EVAL execution instrument. Anchors are the SHA-256 of two accepted manifests
// (offline R-EVAL RC3 and ASK-REMOTE R-C RC1), pinned here; every file they list is re-hashed from disk, plus the frozen
// dataset/fixture/order identity (via the accepted dataset functions) and this tool's own files. Checked at start and
// again before EVERY submission boundary; any difference is drift. Declared administrative routing/status overlays may
// differ from the historical manifests ONLY at their exact pinned current hashes (frozen digest in the identity). Nothing here proves what a RUNNING
// server process loaded: that stays UNVERIFIED.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { flattenCorpus, loadCorpusFiles, MANIFEST_FILE, ORDER_SEED, readData, stableOrder } from '../ask-remote-eval/dataset.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import { datasetManifest } from '../ask-remote-eval/evidence.ts';

const ROOT = new URL('../../', import.meta.url);
const TOOL_DIR = new URL('./', import.meta.url);
export const OFFLINE_MANIFEST = { path: 'verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_RC3_MANIFEST.json', sha256: '3af49f790a2bff92a64b8ef83a9c7b8c1a174f758fb863de97e49086778ca58c' };
export const OFFLINE_STATUS = 'verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_STATUS.json';
export const RC_MANIFEST = { path: 'verification/stage5/S5ASKREMOTE_RC_RC1_MANIFEST.json', sha256: '1b8128214440ba444b329fa496242aa8a9f074ac7fb106124ad6e7d6d0d94731' };
/**
 * Declared administrative overlays: routing/status paths whose bytes legitimately differ from the historical accepted
 * manifests (RC6 plan closed list, recorded R-C closure/role-policy deltas, root routing of this instrument). Each is pinned
 * at its EXACT current SHA-256; any other bytes are drift, exactly like frozen content. Never re-sampled or adopted.
 */
export const ADMIN_OVERLAYS: Readonly<Record<string, string>> = Object.freeze({
  'AGENTS.md': '760214a53de2d8386d56a83de7237c22044b2240cf0523f3b7cb173fd2dfb93b',
  'docs/AI_CONTEXT_MAP.md': 'e6083a0d188e497da29e61a4ddc5fbc6cad8d92fa57bf0b500170f7257513f04',
  'docs/DEVELOPMENT_WORKFLOW.md': '1dc7abece0aa6a690ca214aa6f38411e4abdfa45f92d280a239727257858c3e6',
  'docs/stage5/IMPLEMENTATION_STATUS.md': 'a851475a4755442b45e99f9a30b3da25c5ea95bcb8507c36b9d78d6065c2697f',
  'docs/stage5/REVIEW_STATUS.md': '09e1b1a030c2afb6e8af4b995bb03078e21073b9d1aa6c10e1353c5721ab8a6d',
  'docs/stage5/ask/remote/DESIGN_STATUS.md': 'ba8e704b75f218b09d4f9ad0cacd10917c205acd685036852238b6b61f18c6d2'
});
export const ADMIN_PATHS: readonly string[] = Object.freeze(Object.keys(ADMIN_OVERLAYS));
/** Pure comparator: overlay paths whose actual hash (null = unreadable) differs from the pinned expected hash, sorted. */
export function overlayDrift(expected: Readonly<Record<string, string>>, actual: (path: string) => string | null): string[] {
  return Object.keys(expected).filter(p => actual(p) !== expected[p]).sort();
}
/** Frozen digest of the PINNED overlay table (verified equal to disk before identity is issued). */
export const adminOverlaySha256 = (overlays: Readonly<Record<string, string>> = ADMIN_OVERLAYS): string =>
  createHash('sha256').update(Object.keys(overlays).sort().map(p => `${p}:${overlays[p]}`).join('\n')).digest('hex');

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path: string): string | null => { try { return sha(readFileSync(new URL(path, ROOT))); } catch { return null; } };
interface Entry { readonly path: string; readonly sha256: string }
const entries = (v: unknown): Entry[] => Array.isArray(v) && v.every(e => e !== null && typeof e === 'object' && typeof e.path === 'string'
  && typeof e.sha256 === 'string') ? v as Entry[] : [];

export interface Identity {
  readonly offlinePackageHash: string; readonly offlineManifestSha256: string; readonly rcPackageHash: string; readonly rcManifestSha256: string;
  readonly datasetCorpusSha256: string; readonly fixtureSha256: string; readonly orderSha256: string; readonly orderSeed: string;
  readonly executionToolSha256: string; readonly comparatorSha256: string; readonly browserValidatorSha256: string; readonly projectionSha256: string;
  readonly adminOverlaySha256: string;
}
interface DatasetInfo { corpusSha256: string; fixtures: { sha256: string }; orderSha256: string; labelStatus: string; attestation: string }
export interface Snapshot {
  readonly ok: boolean; readonly drift: readonly string[]; readonly adminDeltaPaths: readonly string[]; readonly identity: Identity | null;
  readonly filesChecked: number; readonly labelStatus: string; readonly attestation: string;
}

/** Hash of this tool's own files (sorted names; `.ts` and AGENTS.md only). */
export function executionToolSha256(): string {
  const names = readdirSync(TOOL_DIR).filter(n => n.endsWith('.ts') || n === 'AGENTS.md').sort();
  return sha(names.map(n => `${n}:${sha(readFileSync(new URL(n, TOOL_DIR)))}`).join('\n'));
}
const group = (paths: readonly string[]): string => sha(paths.map(p => `${p}:${fileSha(p) ?? 'MISSING'}`).join('\n'));

export function verifyArtifact(): Snapshot {
  const drift: string[] = []; const admin = new Set<string>(); let filesChecked = 0;
  const pinned = (anchor: { path: string; sha256: string }, code: string): Record<string, unknown> | null => {
    if (fileSha(anchor.path) !== anchor.sha256) { drift.push(code); return null; }
    return JSON.parse(readFileSync(new URL(anchor.path, ROOT), 'utf8')) as Record<string, unknown>;
  };
  const check = (list: readonly Entry[], code: string): void => {
    if (list.length === 0) drift.push(`${code}_EMPTY`);
    for (const e of list) {
      filesChecked += 1;
      if (fileSha(e.path) === e.sha256) continue;
      // A historical manifest mismatch is tolerated ONLY on a declared overlay whose current bytes equal the pinned hash.
      if (ADMIN_PATHS.includes(e.path) && fileSha(e.path) === ADMIN_OVERLAYS[e.path]) admin.add(e.path); else if (!drift.includes(code)) drift.push(code);
    }
  };
  if (overlayDrift(ADMIN_OVERLAYS, fileSha).length > 0) drift.push('ADMIN_OVERLAY_DRIFT');
  filesChecked += ADMIN_PATHS.length;
  const offline = pinned(OFFLINE_MANIFEST, 'OFFLINE_MANIFEST_DRIFT');
  const rc = pinned(RC_MANIFEST, 'RC_MANIFEST_DRIFT');
  if (offline) {
    const files = entries(offline.files);
    if (sha(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) !== offline.packageHash) drift.push('OFFLINE_PACKAGE_HASH');
    check(files, 'OFFLINE_FILE_DRIFT');
  }
  if (rc) { check(entries(rc.files), 'RC_SOURCE_DRIFT'); check(entries(rc.builtInventory), 'RC_BUILD_DRIFT'); }
  let status: Record<string, unknown> = {};
  try { status = JSON.parse(readFileSync(new URL(OFFLINE_STATUS, ROOT), 'utf8')) as Record<string, unknown>; } catch { drift.push('OFFLINE_STATUS_UNREADABLE'); }
  if (status.status !== 'APPROVED_OFFLINE_PACKAGE' || !offline || status.packageHash !== offline.packageHash || status.manifest !== OFFLINE_MANIFEST.path
    || status.dataAdmission !== 'NOT_ADMITTED' || status.paidProductCalls !== 0) drift.push('OFFLINE_STATUS_MISMATCH');

  let dataset: DatasetInfo | null = null;
  try {
    const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
    const derived = datasetManifest(cases) as unknown as DatasetInfo;
    const committed = JSON.parse(readData(MANIFEST_FILE).toString('utf8')) as unknown;
    const order = stableOrder(cases.map(c => c.caseId));
    if (JSON.stringify(committed) !== JSON.stringify(derived) || order.orderSha256 !== derived.orderSha256 || cases.length !== 200) drift.push('DATASET_MANIFEST_MISMATCH');
    else dataset = derived;
  } catch { drift.push('DATASET_UNREADABLE'); }

  const identity: Identity | null = offline && rc && dataset ? {
    offlinePackageHash: String(offline.packageHash), offlineManifestSha256: OFFLINE_MANIFEST.sha256, rcPackageHash: String(rc.packageHash),
    rcManifestSha256: RC_MANIFEST.sha256, datasetCorpusSha256: dataset.corpusSha256, fixtureSha256: dataset.fixtures.sha256, orderSha256: dataset.orderSha256,
    orderSeed: ORDER_SEED, executionToolSha256: executionToolSha256(),
    comparatorSha256: group(['scripts/ask-remote-eval/predicates.ts', 'scripts/ask-remote-eval/expected-facts.ts', 'scripts/ask-remote-eval/fixtures.ts']),
    browserValidatorSha256: group(['apps/operator/src/validate-ask.ts', 'apps/operator/src/validate-ask-facts.ts', 'apps/operator/src/validate-core.ts', 'apps/operator/src/ask-contracts.ts']),
    projectionSha256: group(['packages/ask/remote/answer.ts', 'packages/ask/compiler.ts', 'packages/ask/selector.ts', 'packages/ask/projection.ts', 'packages/ask/planner.ts']),
    adminOverlaySha256: adminOverlaySha256()
  } : null;
  return { ok: drift.length === 0 && identity !== null, drift, adminDeltaPaths: [...admin].sort(), identity, filesChecked,
    labelStatus: dataset?.labelStatus ?? 'UNKNOWN', attestation: dataset?.attestation ?? 'UNKNOWN' };
}

/** Same identity as at start (every hash) and still drift-free. */
export const sameIdentity = (a: Snapshot, b: Snapshot): boolean => a.ok && b.ok && JSON.stringify(a.identity) === JSON.stringify(b.identity);

/**
 * Why a LIVE admission/readiness claim is refused. This tool version has NO admitted mode and no flag that removes these:
 * a future admitted run needs a separately accepted tool revision bound to the admitted manifest plus the named contracts.
 */
export function admissionBlockers(s: Snapshot): string[] {
  const out: string[] = [];
  if (!s.ok) out.push('ARTIFACT_IDENTITY_NOT_VERIFIED');
  if (s.labelStatus !== 'HUMAN_ATTESTED' || s.attestation !== 'HUMAN_ATTESTATION_ACCEPTED') out.push('HUMAN_LABEL_ATTESTATION_PENDING');
  out.push('OWNER_DATA_BUDGET_ADMISSION_ABSENT', 'EXECUTION_ARTIFACT_ACCEPTANCE_PENDING', 'LEDGER_METADATA_READ_CONTRACT_MISSING',
    'CLOSURE_RECEIPT_READ_CONTRACT_MISSING', 'FIXTURE_DB_PROVISIONING_CONTRACT_MISSING', 'TRANSIENT_RESPONSE_HANDOFF_CONTRACT_MISSING',
    'SERVER_PROCESS_IDENTITY_UNVERIFIED', 'EGRESS_PLATFORM_PROOF_ABSENT', 'PRIVACY_SCAN_NOT_MEASURED', 'OPERATOR_IDENTITY_ATTESTED_ONLY');
  return out;
}
