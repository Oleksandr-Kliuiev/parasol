// Fails the build when the JavaScript and CSS loaded before the first page render exceed the budget (docs/03 §10: ≤ 300 KB gzip).
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const outDir = new URL('../../src/Hosts/Crm.Web/wwwroot/', import.meta.url).pathname;
const budgetKb = Number(process.env.BUNDLE_BUDGET_KB ?? 300);
const html = readFileSync(join(outDir, 'index.html'), 'utf8');
const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);

let total = 0;
for (const file of new Set(files)) {
  const gzip = gzipSync(readFileSync(join(outDir, file))).length;
  total += gzip;
  console.log(`${(gzip / 1024).toFixed(1).padStart(8)} KB  ${file} (${(statSync(join(outDir, file)).size / 1024).toFixed(0)} KB raw)`);
}
console.log(`${(total / 1024).toFixed(1).padStart(8)} KB  initial total (budget ${budgetKb} KB)`);
if (total / 1024 > budgetKb) {
  console.error('Initial bundle exceeds the budget.');
  process.exit(1);
}
