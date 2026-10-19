// Parasol UX demo: smoke checks in a real browser (flows, keyboard, axe WCAG 2.2 AA in both themes).
// Serves the demo itself on a free local port. Uses Playwright and axe from apps/crm/web (npm ci there first).
// Usage: node docs/ux/demo/tools/smoke.mjs        (exit code 1 on any failure)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(demo, '../../../apps/crm/web/package.json'));
const { chromium } = req('playwright');
const { default: AxeBuilder } = req('@axe-core/playwright');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript' };
const server = createServer(async (rq, rs) => {
  const path = normalize(decodeURIComponent(new URL(rq.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(demo, path || 'index.html');
  if (!file.startsWith(demo)) { rs.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    rs.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch (e) { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html#`;

const browser = await chromium.launch();
let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const pageErrors = [];

async function open(role, route, opts) {
  const ctx = await browser.newContext({ viewport: { width: (opts && opts.width) || 1440, height: 900 }, colorScheme: (opts && opts.theme) || 'light' });
  await ctx.addInitScript(([r, th]) => localStorage.setItem('parasol-ux-demo', JSON.stringify({ role: r, theme: th, lang: 'ru' })), [role, (opts && opts.theme) || 'light']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(base + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  return { ctx, page };
}
const toast = (page) => page.evaluate(() => [...document.querySelectorAll('.toast span')].map((s) => s.textContent).join(' | '));
const focusId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

/* ---------- Flows ---------- */

let { ctx, page } = await open('technician', '/observations');
await page.focus('.obs-table button[data-action="assign"]');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
ok(await page.evaluate(() => document.querySelector('.popover') && document.querySelector('.popover').contains(document.activeElement)), 'assign popover opens with focus inside');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok(await page.evaluate(() => !document.querySelector('.popover') && document.activeElement.matches('[data-action="assign"]')), 'Escape closes it and returns focus');
await page.keyboard.press('Enter');
await page.click('.popover [data-action="assign-confirm"]');
await page.waitForTimeout(250);
ok((await toast(page)).length > 0 && (await page.evaluate(() => document.activeElement.matches('[data-action="open-task"]'))), 'assigning shows a receipt and focuses the new task chip');
const raceRow = page.locator('.obs-table tr', { hasText: 'Eikeli' }).first();
await raceRow.locator('[data-action="assign"]').click();
await page.waitForTimeout(200);
ok(await page.locator('.popover').textContent().then((s) => s.includes('Jonas')), 'a colleague’s task is shown instead of a duplicate');
await ctx.close();

({ ctx, page } = await open('technician', '/day'));
await page.evaluate(() => P.actions['log-time']({ dataset: { task: 't2' } }));
await page.waitForTimeout(250);
ok((await focusId(page)) === 'tf-hours', 'time form starts in the hours field');
await page.click('[data-action="save-time"]');
await page.waitForTimeout(150);
ok(await page.locator('#tf-desc-err').count() === 1, 'billable time without a description is refused inline');
await page.fill('#tf-desc', 'Очистка диска и перенос архива');
await page.click('[data-action="save-time"]');
await page.waitForTimeout(250);
await page.click('.toast [data-action="toast-action"]');
await page.waitForTimeout(250);
ok((await page.evaluate(() => P.data.task('t2').status)) === 'Done', 'time saved and the toast completes the task');
await ctx.close();

({ ctx, page } = await open('technician', '/tasks'));
await page.evaluate(() => P.openTask('t3'));
await page.waitForTimeout(250);
await page.fill('#te-time', '15:00');
await page.click('[data-action="save-task"]');
await page.waitForTimeout(250);
ok(await page.locator('#drawer .banner.is-warn').count() === 1 && (await page.inputValue('#te-time')) === '15:00', 'an edit conflict keeps the draft and explains both values');
await ctx.close();

({ ctx, page } = await open('servicelead', '/time/approve'));
const card = page.locator('section.card', { hasText: 'Ingrid Solberg' }).first();
await card.locator('summary').click();
await card.locator('input[data-action="appr-pick"]').first().uncheck();
await page.waitForTimeout(150);
ok((await page.locator('section.card', { hasText: 'Ingrid Solberg' }).first().locator('[data-action="approve"]').textContent()).includes('16'), 'approval can leave one entry out');
await ctx.close();

({ ctx, page } = await open('admin', '/day'));
await page.locator('[data-action="open-invoice"]').first().click();
await page.waitForTimeout(250);
await page.click('#drawer [data-action="remind-invoice"]');
await page.waitForTimeout(250);
ok((await page.inputValue('#nt-subject')).length > 0, 'an overdue invoice leads to a prefilled reminder task');
await ctx.close();

({ ctx, page } = await open('technician', '/day'));
await page.keyboard.press('Control+k');
await page.keyboard.type('reception');
await page.waitForTimeout(200);
ok((await page.locator('.palette-item', { hasText: 'RECEPTION-PC' }).count()) === 2, 'the palette shows both machines named RECEPTION-PC with their customers');
await page.keyboard.press('Escape');
await page.reload({ waitUntil: 'networkidle' });
await page.keyboard.press('Tab');
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
ok((await focusId(page)) === 'view' && (await page.evaluate(() => location.hash)) === '#/day', 'the skip link focuses the content and keeps the route');
await page.keyboard.press('g'); await page.keyboard.press('o');
await page.waitForTimeout(200);
ok((await page.evaluate(() => location.hash)) === '#/observations', 'g then o opens the observation queue');
await ctx.close();

({ ctx, page } = await open('technician', '/observations'));
await page.locator('.obs-table button[data-action="open-observation"]').first().click();
await page.waitForTimeout(250);
await page.locator('#drawer a[href^="#/customers/"]').click();
await page.waitForTimeout(300);
ok((await page.evaluate(() => location.hash.startsWith('#/customers/') && !document.getElementById('drawer').open)), 'a link inside the drawer navigates and closes the drawer');
await page.goBack();
await page.waitForTimeout(300);
ok((await page.evaluate(() => location.hash)) === '#/observations', 'Back returns to the queue');
await ctx.close();

({ ctx, page } = await open('technician', '/day', { width: 390 }));
await page.click('.tabbar [data-action="open-more"]');
await page.waitForTimeout(300);
await page.click('#drawer a.menu-item[href="#/contracts"]');
await page.waitForTimeout(300);
ok((await page.evaluate(() => location.hash === '#/contracts' && !document.getElementById('drawer').open)), 'phone: a page chosen in "More" opens and the sheet closes');
await ctx.close();

/* ---------- axe ---------- */

const AXE = [['/day', 'technician'], ['/day', 'admin'], ['/observations', 'technician'], ['/tasks', 'servicelead'], ['/time/approve', 'admin'],
  ['/customers', 'technician'], ['/customers/fjordlys/technical', 'technician'], ['/customers/fjordlys/finance', 'admin'],
  ['/billing', 'admin'], ['/invoices', 'admin'], ['/connections', 'admin'], ['/admin', 'admin']];
for (const theme of ['light', 'dark']) {
  for (const [route, role] of AXE) {
    ({ ctx, page } = await open(role, route, { theme }));
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    ok(res.violations.length === 0, `axe ${theme} ${route} [${role}]` + (res.violations.length ? ': ' + res.violations.map((v) => v.id).join(', ') : ''));
    await ctx.close();
  }
}

ok(pageErrors.length === 0, 'no script errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
