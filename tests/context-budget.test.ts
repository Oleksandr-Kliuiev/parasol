import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Context budget: an active source, test, SQL or CSS file may not exceed 700 lines. Split responsibilities out of a file
// before it grows past the cap (docs/AI_CONTEXT_MAP.md). Generated output, dependencies and the lockfile are not active files.
const MAX_LINES = 700;
const ACTIVE = /\.(ts|tsx|js|mjs|cjs|sql|prisma|css)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const root = new URL('../', import.meta.url);

async function activeFiles(dir: URL, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...await activeFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (ACTIVE.test(entry.name)) out.push(`${prefix}${entry.name}`);
  }
  return out;
}

test(`no active file exceeds ${MAX_LINES} lines`, async () => {
  const files = await activeFiles(root);
  assert.ok(files.length > 20, 'the scan found the project files');
  const oversized: string[] = [];
  for (const file of files) {
    const lines = (await readFile(new URL(file, root), 'utf8')).split('\n').length;
    if (lines > MAX_LINES) oversized.push(`${file}: ${lines}`);
  }
  assert.deepEqual(oversized, [], 'split these files before extending them');
});
