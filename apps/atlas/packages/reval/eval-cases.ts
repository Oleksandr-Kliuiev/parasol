import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DATASET_DATA_DIR, DATASET_MANIFEST_SHA256, isFixtureId } from './dataset.ts';
import { DatasetError } from './dataset.ts';

/**
 * The frozen case → fixture mapping for ARM_CASE checks (04 "The controller checks the frozen case-to-fixture mapping"). Reads the
 * manifest (pinned bytes) and every case file whose sha256 equals its manifest entry, and keeps ONLY caseId → fixtureId: the
 * question/label text of each line is dropped immediately and never stored, logged or exported.
 */
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export function loadCaseFixtures(read: (name: string) => Buffer = name => readFileSync(DATASET_DATA_DIR + name)): ReadonlyMap<string, string> {
  const manifestBytes = read('DATASET_MANIFEST.json');
  if (sha(manifestBytes) !== DATASET_MANIFEST_SHA256) throw new DatasetError('MANIFEST');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files?: { name?: unknown; sha256?: unknown; cases?: unknown }[]; caseCount?: unknown };
  const out = new Map<string, string>();
  for (const f of manifest.files ?? []) {
    if (typeof f.name !== 'string' || !/^cases-[a-z-]+\.jsonl$/.test(f.name)) throw new DatasetError('MANIFEST_ENTRY');
    const bytes = read(f.name);
    if (sha(bytes) !== f.sha256) throw new DatasetError('CASES');
    const lines = bytes.toString('utf8').split('\n').filter(l => l.length > 0);
    if (lines.length !== f.cases) throw new DatasetError('CASES');
    for (const line of lines) {
      const c = JSON.parse(line) as { caseId?: unknown; fixtureId?: unknown };
      if (typeof c.caseId !== 'string' || !isFixtureId(c.fixtureId) || out.has(c.caseId)) throw new DatasetError('CASES');
      out.set(c.caseId, c.fixtureId);
    }
  }
  if (out.size !== manifest.caseCount || out.size !== 200) throw new DatasetError('CASES');
  return out;
}
