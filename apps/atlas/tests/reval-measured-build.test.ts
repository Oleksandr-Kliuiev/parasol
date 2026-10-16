import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDigests } from '../packages/reval/launch.ts';

// RS-C-C (review rc1 F4): C's measured build manifest covers the sealed measured console that the bridge server serves — a changed
// dist/operator-measured byte changes buildManifestSha256 (which the registration and every SNAPSHOT bind); the ordinary console,
// which the bridge server never serves, is outside it. A synthetic minimal tree; no build, DB or network.
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'reval-build-'));
  for (const [path, text] of [['dist/apps/api/src/main.js', 'main'], ['dist/packages/reval/x.js', 'x'], ['dist/operator-measured/index.html', '<html>'],
    ['dist/operator-measured/main-measured.js', 'measured'], ['dist/operator/main.js', 'ordinary'], ['package-lock.json', '{}'], ['prisma/roles.sql', '--'],
    ['prisma/migrations/0001_x/migration.sql', '--'], ['prisma/roles/x.sql', '--'], ['packages/reval/x.ts', 'x'], ['scripts/reval-server/x.ts', 'x'],
    ['native/reval-peer/peer.c', '/* c */']]) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text);
  }
  return root;
}
test('buildManifestSha256 covers dist/operator-measured (and not the ordinary dist/operator)', async () => {
  const root = tree();
  const base = (await computeDigests(root, process.execPath, '0'.repeat(64))).buildManifestSha256;
  writeFileSync(join(root, 'dist/operator/main.js'), 'ordinary changed');
  assert.equal((await computeDigests(root, process.execPath, '0'.repeat(64))).buildManifestSha256, base, 'the ordinary console is not part of the measured build');
  writeFileSync(join(root, 'dist/operator-measured/main-measured.js'), 'measured changed');
  assert.notEqual((await computeDigests(root, process.execPath, '0'.repeat(64))).buildManifestSha256, base, 'a measured console byte changes the build identity');
});
