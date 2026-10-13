// npm run ui:build — builds the local operator console (docs/stage5/04_ARCHITECTURE_AND_UX.md) into dist/operator:
// the pinned TypeScript compiler emits native ES modules (apps/operator/tsconfig.json), the fixed HTML/CSS are copied and a
// deterministic asset manifest is written. The API serves exactly the manifest's files (apps/api/src/operator/assets.ts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MANIFEST_FORMAT, MANIFEST_NAME, SERVABLE_NAME_PATTERN } from '../apps/api/src/operator/manifest.ts';
import { buildMeasuredConsole } from './operator-measured-build.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'dist', 'operator');
const STATIC_FILES = ['index.html', 'styles.css'];

await rm(out, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'apps/operator/tsconfig.json')],
  { cwd: root, encoding: 'utf8' });
if (tsc.status !== 0) { process.stderr.write(`${tsc.stdout}${tsc.stderr}`.slice(0, 4000)); process.exit(1); }
for (const file of STATIC_FILES) await copyFile(join(root, 'apps/operator', file), join(out, file));

const files = [];
for (const entry of (await readdir(out, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
  if (!entry.isFile() || !SERVABLE_NAME_PATTERN.test(entry.name)) throw new Error(`OPERATOR_BUILD_UNEXPECTED_OUTPUT ${entry.name}`);
  const body = await readFile(join(out, entry.name));
  if (entry.name.endsWith('.js') && /sourceMappingURL|\beval\s*\(|new\s+Function\s*\(|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(body.toString('utf8'))) {
    throw new Error(`OPERATOR_BUILD_FORBIDDEN_CONSTRUCT ${entry.name}`);
  }
  files.push({ path: entry.name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') });
}
if (!files.some(f => f.path === 'index.html') || !files.some(f => f.path === 'main.js')) throw new Error('OPERATOR_BUILD_INCOMPLETE');
await writeFile(join(out, MANIFEST_NAME), `${JSON.stringify({ format: MANIFEST_FORMAT, files }, null, 2)}\n`);
console.log(`operator console: ${files.length} assets, manifest ${createHash('sha256').update(await readFile(join(out, MANIFEST_NAME))).digest('hex')}`);
// R-EVAL RS-C-C: the sealed measured console (served only by the measured bridge server) is built next to it, never into dist/operator.
console.log(`measured operator console: manifest ${await buildMeasuredConsole(root)}`);
