import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import type { Reader } from '../../scripts/reval-instrument/identity.ts';

// Historical bytes are test inputs, never replacement approval seals for the evolving application.
// The production verifier still checks every original anchor, source, build and candidate seal.
const frozen = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/reval-history/rsdc.json.gz', import.meta.url))).toString('utf8')) as {
  version: number; view: string; files: Record<string, string>;
};
assert.equal(frozen.version, 1); assert.equal(frozen.view, 'rsdc');
const files = new Map(Object.entries(frozen.files).map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')]));
export const historicalReader: Reader = path => {
  const bytes = files.get(path);
  if (bytes) return Buffer.from(bytes);
  try { return readFileSync(new URL(`../../${path}`, import.meta.url)); } catch { return null; }
};
export const verifyTestRevision = () => {
  const result = verifyRevision(historicalReader);
  assert.equal(result.snapshot.ok, true, `Historical fixture failed verification: ${result.snapshot.drift.join(',')}`);
  return result;
};
export const verifyTestArtifact = () => verifyTestRevision().snapshot;
export const loadContext = () => bindCorpus(verifyTestArtifact());
export const testArtifacts = { loadContext, verifyArtifact: verifyTestArtifact };
