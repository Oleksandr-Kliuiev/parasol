// R-EVAL RS-C-C: builds the SEALED measured console (rs-c/IMPLEMENTATION_BRIEF_C.md §1) into dist/operator-measured. It compiles the
// unchanged accepted console sources (apps/operator/src, without the ordinary main.ts) together with apps/operator/measured using the
// pinned TypeScript compiler (apps/operator/tsconfig.measured.json), flattens the output into one directory (the accepted asset
// loader serves only flat names; measured modules' `../src/` imports are rewritten to `./`), copies the fixed CSS and the measured
// HTML shell, applies the accepted forbidden-construct scan and writes the accepted manifest format. The ordinary dist/operator is
// never touched. Only the measured bridge server serves this directory (apps/api/src/reval/evaluation.ts).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FORMAT, MANIFEST_NAME, SERVABLE_NAME_PATTERN } from '../apps/api/src/operator/manifest.ts';

const FORBIDDEN = /sourceMappingURL|\beval\s*\(|new\s+Function\s*\(|innerHTML|outerHTML|insertAdjacentHTML|document\.write/;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function buildMeasuredConsole(root = fileURLToPath(new URL('../', import.meta.url))): Promise<string> {
  const tmp = join(root, 'dist', '.operator-measured-build'); const out = join(root, 'dist', 'operator-measured');
  await rm(tmp, { recursive: true, force: true }); await rm(out, { recursive: true, force: true });
  const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'apps/operator/tsconfig.measured.json')],
    { cwd: root, encoding: 'utf8' });
  if (tsc.status !== 0) throw new Error(`OPERATOR_MEASURED_BUILD_TSC ${`${tsc.stdout}${tsc.stderr}`.slice(0, 4000)}`);
  await mkdir(out);
  const seen = new Set<string>();
  for (const [dir, rewrite] of [['src', false], ['measured', true]] as const) {
    for (const entry of (await readdir(join(tmp, dir), { withFileTypes: true })).sort(byName)) {
      if (!entry.isFile() || !entry.name.endsWith('.js') || seen.has(entry.name)) throw new Error(`OPERATOR_MEASURED_BUILD_UNEXPECTED_OUTPUT ${dir}/${entry.name}`);
      seen.add(entry.name);
      let text = await readFile(join(tmp, dir, entry.name), 'utf8');
      if (rewrite) text = text.replace(/(from\s+|import\s*\(\s*)(['"])\.\.\/src\//g, '$1$2./');
      if (/\.\.\//.test(text)) throw new Error(`OPERATOR_MEASURED_BUILD_PARENT_IMPORT ${entry.name}`);
      await writeFile(join(out, entry.name), text);
    }
  }
  await rm(tmp, { recursive: true, force: true });
  for (const file of ['tokens.css', 'styles.css', 'vardahei-it-logo.png']) await copyFile(join(root, 'apps/operator', file), join(out, file));
  await copyFile(join(root, 'apps/operator/measured/index.html'), join(out, 'index.html'));
  const files = [];
  for (const entry of (await readdir(out, { withFileTypes: true })).sort(byName)) {
    if (!entry.isFile() || !SERVABLE_NAME_PATTERN.test(entry.name)) throw new Error(`OPERATOR_MEASURED_BUILD_UNEXPECTED_OUTPUT ${entry.name}`);
    const body = await readFile(join(out, entry.name));
    if (entry.name.endsWith('.js') && FORBIDDEN.test(body.toString('utf8'))) throw new Error(`OPERATOR_MEASURED_BUILD_FORBIDDEN_CONSTRUCT ${entry.name}`);
    files.push({ path: entry.name, bytes: body.byteLength, sha256: sha(body) });
  }
  if (!files.some(f => f.path === 'index.html') || !files.some(f => f.path === 'main-measured.js') || files.some(f => f.path === 'main.js')) {
    throw new Error('OPERATOR_MEASURED_BUILD_INCOMPLETE');
  }
  await writeFile(join(out, MANIFEST_NAME), `${JSON.stringify({ format: MANIFEST_FORMAT, files }, null, 2)}\n`);
  return sha(await readFile(join(out, MANIFEST_NAME)));
}

if (import.meta.url === new URL(process.argv[1]!, 'file://').href || process.argv[1]?.endsWith('operator-measured-build.ts')) {
  const manifest = await buildMeasuredConsole();
  console.log(`measured operator console: manifest ${manifest}`);
}
