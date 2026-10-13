import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// S5-A built artifact (A1, A7): dist/operator as produced by npm run ui:build. The emitted import graph is closed over
// the manifest, contains no Node/runtime-server or bare imports, and the static files carry no inline code, handlers,
// remote resources, storage, logging or HTML-injection APIs. Only the credential module builds an Authorization header.
const out = fileURLToPath(new URL('../../dist/operator/', import.meta.url));
interface Entry { path: string; bytes: number; sha256: string }

test('manifest lists exactly the built files with matching sizes and hashes', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { format: string; files: Entry[] };
  expect(manifest.format).toBe('atlas-operator-assets-v1');
  const names = (await readdir(out)).filter(n => n !== 'manifest.json').sort();
  expect(manifest.files.map(f => f.path).sort()).toEqual(names);
  for (const file of manifest.files) {
    const body = await readFile(join(out, file.path));
    expect([file.path, body.byteLength, createHash('sha256').update(body).digest('hex')]).toEqual([file.path, file.bytes, file.sha256]);
  }
  expect(names.filter(n => !/^[a-z][a-z0-9-]*\.(js|css|html)$/.test(n))).toEqual([]);
});

test('emitted ES module graph is closed, relative and browser-only', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { files: Entry[] };
  const scripts = manifest.files.map(f => f.path).filter(p => p.endsWith('.js'));
  const reachable = new Set<string>(['main.js']);
  const queue = ['main.js'];
  while (queue.length) {
    const file = queue.shift()!;
    const code = await readFile(join(out, file), 'utf8');
    expect(/\bimport\s*\(/.test(code), `${file} dynamic import`).toBe(false);
    expect(/\brequire\s*\(/.test(code), `${file} require`).toBe(false);
    for (const [, specifier] of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
      expect(specifier, file).toMatch(/^\.\/[a-z][a-z0-9-]*\.js$/);
      const target = specifier!.slice(2);
      expect(scripts, `${file} → ${specifier}`).toContain(target);
      if (!reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  }
  expect([...reachable].sort()).toEqual([...scripts].sort());
});

test('static assets: no inline code, handlers, remote resources, storage, logging or HTML injection', async () => {
  const html = await readFile(join(out, 'index.html'), 'utf8');
  expect([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0])).toEqual(['<script type="module" src="main.js">']);
  expect(/<script\b[^>]*>[^<]+<\/script>/.test(html)).toBe(false);
  expect(/\son[a-z]+\s*=/i.test(html)).toBe(false);
  expect(/\sstyle\s*=/i.test(html)).toBe(false);
  expect(/(?:src|href)\s*=\s*["'](?:https?:|\/\/|data:|javascript:)/i.test(html)).toBe(false);
  expect(/\sname\s*=/.test(html.slice(html.indexOf('<form'), html.indexOf('</form>')))).toBe(false);
  const css = await readFile(join(out, 'styles.css'), 'utf8');
  expect(/url\(|@import|https?:/i.test(css)).toBe(false);
  const forbidden = /localStorage|sessionStorage|document\.cookie|indexedDB|serviceWorker|SharedWorker|BroadcastChannel|postMessage|sendBeacon|XMLHttpRequest|WebSocket|EventSource|history\.(?:push|replace)State|console\.|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|srcdoc|sourceMappingURL|location\.(?:assign|replace|href\s*=)/;
  for (const name of (await readdir(out)).filter(n => n.endsWith('.js'))) {
    const code = await readFile(join(out, name), 'utf8');
    expect(forbidden.exec(code)?.[0] ?? null, name).toBeNull();
    expect(code.includes('Authorization'), name).toBe(name === 'credential.js');
    expect(/globalThis\.fetch|window\.fetch|\bfetch\(/.test(code), name).toBe(name === 'main.js');
  }
});

test('S5-B emitted code: only allowlisted API paths/tools, POST only in the credential holder, no data-driven attributes or URLs', async () => {
  const files = (await readdir(out)).filter(n => n.endsWith('.js'));
  const routes = new Set<string>();
  for (const name of files) {
    const code = await readFile(join(out, name), 'utf8');
    for (const [, path] of code.matchAll(/[`'"](\/[A-Za-z][^`'"]*)[`'"]/g)) routes.add(`${name} ${path}`);
    expect(/\bmethod:\s*'POST'/.test(code), `${name} POST`).toBe(name === 'credential.js');
    expect(code.includes('/tools/execute'), `${name} tool path`).toBe(name === 'operations.js');
    // Attributes are set only from literal names with values the console computes; no href/src/style/srcdoc/on* from data.
    for (const [, attribute] of code.matchAll(/setAttribute\(\s*'([^']+)'/g)) expect(['aria-busy', 'aria-current', 'aria-disabled'], `${name} ${attribute}`).toContain(attribute);
    expect(/\.(href|src|srcdoc|action|formAction)\s*=|\.style\.|\bon[a-z]+\s*=\s*[^=]|setAttribute\(\s*[^'\s]/.test(code), `${name} dynamic attribute`).toBe(false);
  }
  expect([...routes].sort()).toEqual(['operations.js /clients', 'operations.js /clients/${encodeURIComponent(operation.clientId)}/observations',
    'operations.js /clients/${encodeURIComponent(operation.clientId)}/overview', 'operations.js /tools/execute',
    // ASK-B: the two approved fixed Ask operations (docs/stage5/ask/02 "Fixed HTTP surface").
    'operations.js /ask/capabilities', 'operations.js /clients/${encodeURIComponent(clientId)}/ask',
    'origin.js /operator/' /* the S5-A token-entry location check, not a request */].sort());
  // ASK-B: the AskRequestV1 body is built only by the fixed operation; the MOCK badge is static text of the page.
  for (const name of files) expect((await readFile(join(out, name), 'utf8')).includes("'AskRequestV1'"), `${name} Ask body`).toBe(name === 'operations.js');
  expect(await readFile(join(out, 'index.html'), 'utf8')).toContain('Ask Atlas — local synthetic MOCK; no external model');
  const contracts = await readFile(join(out, 'contracts.js'), 'utf8');
  for (const tool of ['atera.alert.list', 'atera.ticket.get', 'huntress.incident.get']) expect(contracts).toContain(`'${tool}'`);
  const toolNames = new Set<string>();
  for (const name of files) for (const [, tool] of (await readFile(join(out, name), 'utf8')).matchAll(/'((?:atera|huntress|atlas|m365|poweroffice|microsoft365)\.[a-z_.]+)'/g)) toolNames.add(tool!);
  expect([...toolNames].sort()).toEqual(['atera.alert.list', 'atera.ticket.get', 'huntress.incident.get']);
});
