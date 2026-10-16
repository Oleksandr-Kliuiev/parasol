import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { verifyRevision } from '../scripts/reval-instrument/identity.ts';
import { verifyArtifact } from '../scripts/ask-remote-eval-execution/artifact.ts';
import { createHistoricalReader, historicalReader } from './support/reval-history.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../', import.meta.url);

test('the complete historical verifier view has pinned provenance and never borrows an unrelated current source', () => {
  const primaryBytes = readFileSync(new URL('tests/fixtures/reval-history/rsdc.json.gz', root));
  assert.equal(sha(primaryBytes), 'd3bbce923f157e4a91e73bcd9b1901e7e2618d531ebb89731a14e064c46512af');
  const primary = JSON.parse(gunzipSync(primaryBytes).toString('utf8')) as { files: Record<string, string> };
  const supplement = JSON.parse(gunzipSync(readFileSync(new URL('tests/fixtures/reval-history/rsdc-supplement.json.gz', root))).toString('utf8')) as {
    sourceCommit: string; files: Record<string, string>; references: Record<string, string>;
  };
  assert.equal(supplement.sourceCommit, '459b1de0f2edd0a6870d12a19af20191d30db9c2');
  const admitted = new Set([...Object.keys(primary.files), ...Object.keys(supplement.files), ...Object.keys(supplement.references)]);
  const requested = new Set<string>();
  const read = (path: string) => { requested.add(path); assert.ok(admitted.has(path), `unfrozen verifier input: ${path}`); return historicalReader(path); };
  assert.equal(verifyRevision(read).snapshot.ok, true);
  assert.equal(verifyArtifact(read).ok, false, 'old RC5 never admits the later RS-D-C view');
  assert.equal(requested.size, 2101, 'all traced identity inputs retain their exact historical provenance');
  assert.equal(admitted.size, requested.size);
  const currentOnly = 'packages/events/clock.ts';
  assert.equal(existsSync(new URL(currentOnly, root)), true);
  assert.equal(historicalReader(currentOnly), null, 'an existing current file is not an unrestricted historical fallback');
  for (const [path, digest] of Object.entries(supplement.references)) assert.equal(sha(historicalReader(path)!), digest, path);
});

test('the supplementary context map is the original accepted bytes; tampering still refuses both identity checks', () => {
  const path = 'docs/AI_CONTEXT_MAP.md';
  const historical = historicalReader(path)!;
  assert.equal(sha(historical), 'a208d967435cf96387a8d76c88ba045c497687644ffe646e1ffa0fa7dfdbbe89');
  const changed = Buffer.concat([historical, Buffer.from('\nchanged historical bytes\n')]);
  const result = verifyRevision(p => p === path ? changed : historicalReader(p));
  assert.equal(result.snapshot.ok, false);
  assert.ok(result.snapshot.drift.includes('SOURCE_DRIFT'));
  assert.ok(result.snapshot.drift.includes('ADMIN_OVERLAY_DRIFT'));
  assert.equal(verifyArtifact(p => p === path ? changed : historicalReader(p)).ok, false);
});

test('a changed or missing historical reference returns null and cannot be replaced by arbitrary current bytes', () => {
  const path = '.env.example';
  assert.ok(historicalReader(path));
  for (const bytes of [Buffer.from('changed historical reference'), null]) {
    const reader = createHistoricalReader(p => p === path ? bytes : readFileSync(new URL(p, root)));
    assert.equal(reader(path), null);
    assert.equal(verifyRevision(reader).snapshot.ok, false);
    assert.equal(reader('packages/events/clock.ts'), null);
  }
});
