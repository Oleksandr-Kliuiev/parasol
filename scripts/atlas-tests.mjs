import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCompletePass } from './test-result.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = join(root, 'apps/atlas');
const suite = process.argv[2] ?? 'unit';
if (!['unit', 'pg'].includes(suite)) throw new Error('Expected unit or pg.');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24.');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The complete Atlas suite includes native Darwin/arm64 peer and durability tests. Run it on macOS arm64 (CI: macos-15). Linux builds are checked separately.');
}
if (suite === 'pg' && (!process.env.ATLAS_PG_ADMIN_URL || !process.env.ATLAS_REVAL_NATIVE_PG_FIXTURE)) {
  throw new Error('Full PostgreSQL tests require ATLAS_PG_ADMIN_URL and ATLAS_REVAL_NATIVE_PG_FIXTURE. See docs/testing/ATLAS.md.');
}
const directory = suite === 'pg' ? 'tests/pg' : 'tests';
const files = readdirSync(join(cwd, directory)).filter(f => f.endsWith('.test.ts')).sort().map(f => `${directory}/${f}`);
const temp = mkdtempSync(join(tmpdir(), 'parasol-tests-'));
try {
  const report = join(temp, 'events.jsonl');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', `--test-concurrency=${suite === 'pg' ? 1 : 2}`,
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${root}scripts/test-events.mjs`, `--test-reporter-destination=${report}`, '--test', ...files], {
    cwd, stdio: 'inherit', env: { ...process.env, ATLAS_REVAL_REHEARSAL: '1' }, timeout: suite === 'pg' ? 7_200_000 : 600_000,
  });
  if (result.error) throw result.error;
  const events = readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const counts = requireCompletePass(events, result.status);
  console.log(`Atlas ${suite}: ${counts.passed}/${counts.tests} passed; no failures, skips, todos or cancellations.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
