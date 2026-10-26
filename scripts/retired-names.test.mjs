import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// M38 retired the separate integration service; its name stays only in the records of the original import, which
// scripts/verify-history.mjs reads. Spelled in pieces so this file does not carry it.
const root = fileURLToPath(new URL('../', import.meta.url));
const retired = new RegExp(['at', 'las'].join(''), 'i');
const history = new Set([
  'docs/migration/sources.json',
  'docs/migration/IMPORT.md',
  'docs/migration/M01-M03.md',
  'docs/migration/M38-OPERATIONS-IN-CRM.md',
]);

test('the retired service is named only in the import history', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const named = files.filter(file => !history.has(file) && (retired.test(file) || retired.test(readFileSync(join(root, file), 'latin1'))));
  assert.deepEqual(named, []);
});
