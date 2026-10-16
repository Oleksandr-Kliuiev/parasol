// RS-D-C sealed build inventory generator (rs-d/IMPLEMENTATION_BRIEF_C.md §1.2). Run AFTER `npm run api:build` on the tree under
// review: lists every output rebuilt from the accepted RS-B … RS-D-B `apps/api|packages` sources (and the sealed measured console
// manifest), minus the outputs of the RS-D-C candidate layer, each with its current sha256, sorted. `--write` replaces the inventory
// file (an RS-D-C candidate path, sealed with the part); `--check` exits 1 when the file differs. A missing output is an error.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CANDIDATE_PATHS } from './candidate.ts';
import { ANCHORS, BUILD_INVENTORY, BUILD_INVENTORY_V1, buildOutputPaths, candidateSet } from './identity.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The inventory text of the current tree (throws on a missing output or an anchor that does not match its pinned hash). */
export function inventoryText(): string {
  const manifests = (['rsbManifest', 'rscaManifest', 'rscbManifest', 'rsccManifest', 'rsdaManifest', 'rsdbManifest'] as const).map(k => {
    const b = read(ANCHORS[k].path);
    if (sha(b) !== ANCHORS[k].sha256) throw new Error(`ANCHOR_DRIFT ${k}`);
    return JSON.parse(b.toString('utf8')) as Record<string, unknown>;
  });
  const outputs = buildOutputPaths(manifests, candidateSet(CANDIDATE_PATHS)).map(path => ({ path, sha256: sha(read(path)) }));
  return `${JSON.stringify({ contractVersion: BUILD_INVENTORY_V1, outputs }, null, 1)}\n`;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const text = inventoryText();
  if (mode === '--write') { writeFileSync(new URL(BUILD_INVENTORY, ROOT), text, { mode: 0o644 }); process.stdout.write(`${JSON.parse(text).outputs.length} outputs\n`); }
  else if (mode === '--check') { let cur = ''; try { cur = read(BUILD_INVENTORY).toString('utf8'); } catch { /* missing */ } process.exit(cur === text ? 0 : 1); }
  else { process.stderr.write('usage: build-inventory.ts --write | --check\n'); process.exit(64); }
}
