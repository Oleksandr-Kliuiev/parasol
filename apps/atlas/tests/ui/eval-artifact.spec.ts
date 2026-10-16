import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// RS-C-C sealed builds (rs-c brief C §1.1): the measured console is a separate flat build whose manifest matches its files, without
// the ordinary entry, forbidden constructs or browser storage; the ordinary console contains nothing of the evaluation pane (no
// pairing control, handoff path or session header). Runs after `npm run api:build` (test:ui builds both consoles).
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const measured = join(ROOT, 'dist/operator-measured'); const ordinary = join(ROOT, 'dist/operator');
const FORBIDDEN = /sourceMappingURL|\beval\s*\(|new\s+Function\s*\(|innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|document\.cookie/;

test('measured build: exact manifest, measured entry only, no forbidden construct or storage API', () => {
  const manifest = JSON.parse(readFileSync(join(measured, 'manifest.json'), 'utf8')) as { format: string; files: { path: string; bytes: number; sha256: string }[] };
  const names = readdirSync(measured).filter(n => n !== 'manifest.json').sort();
  expect(manifest.files.map(f => f.path).sort()).toEqual(names);
  for (const f of manifest.files) {
    const body = readFileSync(join(measured, f.path));
    expect([body.byteLength, createHash('sha256').update(body).digest('hex')], f.path).toEqual([f.bytes, f.sha256]);
    if (f.path.endsWith('.js')) expect(FORBIDDEN.test(body.toString('utf8')), f.path).toBe(false);
  }
  expect(names).toContain('main-measured.js'); expect(names).not.toContain('main.js');
  expect(readFileSync(join(measured, 'index.html'), 'utf8')).toMatch(/<script type="module" src="main-measured\.js"><\/script>/);
});

test('ordinary build: nothing of the evaluation pane (no pairing control, handoff path, session header or measured module)', () => {
  for (const name of readdirSync(ordinary)) {
    const text = readFileSync(join(ordinary, name), 'utf8');
    expect(/evaluation-handoff|X-Atlas-Evaluation|eval-nonce|RevalBrowserHandoff/.test(text), name).toBe(false);
    expect(/^(credential-measured|eval-|main-measured|view-eval)/.test(name), name).toBe(false);
  }
});
