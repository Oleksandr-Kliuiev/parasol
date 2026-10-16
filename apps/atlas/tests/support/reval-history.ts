import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import type { Reader } from '../../scripts/reval-instrument/identity.ts';

// Historical bytes are test inputs, never replacement approval seals for the evolving application.
// The production verifier still checks every original anchor, source, build and candidate seal.
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const primaryBytes = readFileSync(new URL('../fixtures/reval-history/rsdc.json.gz', import.meta.url));
const frozen = JSON.parse(gunzipSync(primaryBytes).toString('utf8')) as {
  version: number; view: string; files: Record<string, string>;
};
assert.equal(frozen.version, 1); assert.equal(frozen.view, 'rsdc');
const files = new Map(Object.entries(frozen.files).map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')]));
// Recover only historical inputs from the exact imported commit. Unchanged repository metadata is usable only at its
// pinned historical hash; an evolving checkout must never silently supply new bytes to the old approval chain.
const supplementBytes = readFileSync(new URL('../fixtures/reval-history/rsdc-supplement.json.gz', import.meta.url));
assert.equal(sha(supplementBytes), 'd374701bc6bec75af74dc68ad8880f237fe559aac1d00aedae279f2b13667c6b');
const supplement = JSON.parse(gunzipSync(supplementBytes).toString('utf8')) as {
  version: number; view: string; sourceCommit: string; primarySha256: string;
  files: Record<string, string>; references: Record<string, string>;
};
assert.equal(supplement.version, 1); assert.equal(supplement.view, 'rsdc-supplement');
assert.equal(supplement.sourceCommit, '459b1de0f2edd0a6870d12a19af20191d30db9c2');
assert.equal(supplement.primarySha256, sha(primaryBytes));
for (const [path, bytes] of Object.entries(supplement.files)) {
  assert.ok(!files.has(path), 'a supplement cannot replace the original frozen archive');
  files.set(path, Buffer.from(bytes, 'base64'));
}
const references = new Map(Object.entries(supplement.references));
assert.equal(references.size, 907);
for (const [path, digest] of references) { assert.ok(!files.has(path)); assert.match(digest, /^[a-f0-9]{64}$/); }
export const createHistoricalReader = (readReference: Reader): Reader => path => {
  const bytes = files.get(path);
  if (bytes) return Buffer.from(bytes);
  const digest = references.get(path);
  if (digest === undefined) return null;
  try {
    const referenced = readReference(path);
    return referenced !== null && sha(referenced) === digest ? referenced : null;
  } catch { return null; }
};
export const historicalReader = createHistoricalReader(path => {
  try { return readFileSync(new URL(`../../${path}`, import.meta.url)); } catch { return null; }
});
export const verifyTestRevision = () => {
  const result = verifyRevision(historicalReader);
  assert.equal(result.snapshot.ok, true, `Historical fixture failed verification: ${result.snapshot.drift.join(',')}`);
  return result;
};
export const verifyTestArtifact = () => verifyTestRevision().snapshot;
export const loadContext = () => bindCorpus(verifyTestArtifact());
export const testArtifacts = { loadContext, verifyArtifact: verifyTestArtifact };
