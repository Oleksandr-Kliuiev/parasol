import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FixtureFile, FixtureSpec } from '../../scripts/ask-remote-eval/fixtures.ts';

/**
 * The frozen offline RC3 dataset as RS-B uses it (rs-b/IMPLEMENTATION_BRIEF.md §0, 03 "One scope, eleven alternative
 * source states"). `datasetManifestSha256` is the sha256 of the manifest BYTES; the fixture file is accepted only when its
 * own sha256 equals the manifest entry. Nothing here reads a case question; only fixture declarations are loaded.
 */
export const DATASET_MANIFEST_SHA256 = '224b1b8dedc775565f0eb1b5c5527096db29d2fc558854c58045d3879f12989a';
export const FIXTURE_FILE_SHA256 = '40f1744ae90b60e171b7897fce08bbe609ef5be6c908992586b470e08dcfaa8d';
/** sha256 of packages/reval/seed-mapping.json (the reviewed seed mapping; seed-plan.ts refuses any other bytes). */
export const SEED_MAPPING_SHA256 = '77d98c700022d5233518bed52ff07c6a37912f456c06d56f9225c9196477563b';
/** 03 "Explicit source-only freshness exception": the ONE pinned reference of this fixture package. */
export const SYNTHETIC_FRESHNESS_AT = '2026-10-10T07:30:00.000Z';
export const FIXTURE_IDS = ['FX01', 'FX02', 'FX03', 'FX04', 'FX05', 'FX06', 'FX07', 'FX08', 'FX09', 'FX10', 'FX11'] as const;
export type FixtureId = typeof FIXTURE_IDS[number];
export const isFixtureId = (v: unknown): v is FixtureId => typeof v === 'string' && (FIXTURE_IDS as readonly string[]).includes(v);

// Source layout `<root>/packages/reval/`; compiled layout `<root>/dist/packages/reval/` (RS-C-A: the bridge server S runs the
// build). Either way the bytes are verified against the pinned hashes, so the location carries no trust.
const COMPILED = /[\\/]dist[\\/]packages[\\/]reval[\\/]$/.test(fileURLToPath(new URL('./', import.meta.url)));
export const DATASET_DATA_DIR = fileURLToPath(new URL(`${COMPILED ? '../../../' : '../../'}docs/stage5/ask/remote/eval/data/`, import.meta.url));
const DATA_DIR = DATASET_DATA_DIR;
export class DatasetError extends Error { constructor(step: string) { super(`DATASET_${step}`); this.name = 'DatasetError'; } }
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface FrozenDataset { readonly manifestSha256: string; readonly file: FixtureFile; readonly byId: ReadonlyMap<FixtureId, FixtureSpec> }
/** Loads and verifies the frozen manifest and fixture file (byte hashes, exact eleven fixture IDs, one scope). */
export function loadFrozenDataset(read: (name: string) => Buffer = name => readFileSync(DATA_DIR + name)): FrozenDataset {
  const manifestBytes = read('DATASET_MANIFEST.json');
  if (sha(manifestBytes) !== DATASET_MANIFEST_SHA256) throw new DatasetError('MANIFEST');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { fixtures?: { name?: unknown; sha256?: unknown } };
  if (manifest.fixtures?.name !== 'fixtures.json' || manifest.fixtures.sha256 !== FIXTURE_FILE_SHA256) throw new DatasetError('MANIFEST_ENTRY');
  const fixtureBytes = read('fixtures.json');
  if (sha(fixtureBytes) !== FIXTURE_FILE_SHA256) throw new DatasetError('FIXTURES');
  const file = JSON.parse(fixtureBytes.toString('utf8')) as FixtureFile;
  const ids = file.fixtures.map(f => f.fixtureId);
  if (ids.join() !== FIXTURE_IDS.join()) throw new DatasetError('FIXTURE_IDS');
  return { manifestSha256: DATASET_MANIFEST_SHA256, file, byId: new Map(file.fixtures.map(f => [f.fixtureId as FixtureId, f])) };
}
