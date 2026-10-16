// Frozen corpus/fixtures in memory for the execution instrument (shared by the operator session and the rehearsal).
// The artifact is verified FIRST; then every data file is read ONCE into a buffer cache, parsed from those exact bytes, and
// the dataset/fixture/order digests of the cached bytes must equal the verified identity (no read-after-verify window).
// Questions, rationales and labels live only in this in-process map; nothing here writes or prints them.
import { flattenCorpus, loadCorpusFiles, readData, stableOrder } from '../ask-remote-eval/dataset.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import { datasetManifest } from '../ask-remote-eval/evidence.ts';
import { loadFixtureFile } from '../ask-remote-eval/fixtures.ts';
import { prepareFixtures } from '../ask-remote-eval/harness.ts';
import { verifyArtifact } from './artifact.ts';
import type { Snapshot } from './artifact.ts';
import type { Corpus } from './session.ts';
import { reject } from './validate.ts';

export interface Ctx { readonly corpus: Corpus; readonly cases: readonly EvalCase[]; readonly snapshot: Snapshot }
let cached: Ctx | null = null;

/** Loads from `read` once per file; the bytes parsed are the bytes hashed. Mismatch with `snapshot` → CORPUS_IDENTITY_MISMATCH. */
export function bindCorpus(snapshot: Snapshot, read: (name: string) => Buffer = readData): Ctx {
  const cache = new Map<string, Buffer>();
  const once = (name: string): Buffer => { let b = cache.get(name); if (!b) { b = Buffer.from(read(name)); cache.set(name, b); } return b; };
  const file = loadFixtureFile(once); const cases = flattenCorpus(loadCorpusFiles(once)) as EvalCase[];
  const manifest = datasetManifest(cases, once) as { corpusSha256: string; fixtures: { sha256: string }; orderSha256: string };
  const { order, orderSha256 } = stableOrder(cases.map(c => c.caseId));
  const id = snapshot.identity;
  if (!snapshot.ok || id === null || manifest.corpusSha256 !== id.datasetCorpusSha256 || manifest.fixtures.sha256 !== id.fixtureSha256
    || orderSha256 !== id.orderSha256 || manifest.orderSha256 !== id.orderSha256 || cases.length !== 200) reject('CORPUS_IDENTITY_MISMATCH');
  const corpus: Corpus = { cases: new Map(cases.map(c => [c.caseId, c])), order, fixtures: prepareFixtures(file), scope: file.scope };
  return { corpus, cases, snapshot };
}
/** Verified snapshot first, then the corpus bound to it (cached per process). */
export function loadContext(): Ctx {
  if (!cached) cached = bindCorpus(verifyArtifact());
  return cached;
}
