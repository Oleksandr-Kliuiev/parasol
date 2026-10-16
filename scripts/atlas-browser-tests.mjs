import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBrowserPass } from './test-result.mjs';
const cwd = fileURLToPath(new URL('../apps/atlas/', import.meta.url));
if (!process.env.ATLAS_PG_ADMIN_URL) throw new Error('Browser tests require the disposable ATLAS_PG_ADMIN_URL.');
const directory = mkdtempSync(join(tmpdir(), 'parasol-browser-'));
try {
  const report = join(directory, 'results.json');
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/ui/playwright.config.ts',
    '--workers=1', '--retries=0', '--forbid-only', '--reporter=list,json', '--output', join(directory, 'output')], {
    cwd, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report }, timeout: 4_200_000,
  });
  if (result.error) throw result.error;
  const stats = requireBrowserPass(JSON.parse(readFileSync(report, 'utf8')), result.status);
  console.log(`Atlas browser: ${stats.expected} passed; no failures, skips or retries.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
