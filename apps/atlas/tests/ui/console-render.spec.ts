import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken } from '../support/operator-ui.ts';
import { dbContext, mutate } from '../support/operator-fixtures.ts';
import { DB_CLIENT, journeyItems, observation, page as obsPage, resourceView, snapshotAlert, WS } from '../support/operator-journey.ts';

// S5-B rendering on the real built console (CSP enforced) with synthetic DB-shaped answers for one intercepted client
// (B2, B4, B5, B7): evidence read states and absence semantics, inert injection, fixed codes for malformed answers,
// source urgency independent of confidence/route/priority label, confirmed/unresolved entity labels, text-only references.
const token = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

interface Answers { context: unknown; queue: unknown; evidence: () => { status: number; body: unknown } }
async function serve(page: Page, answers: Answers) {
  const reply = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  await page.route(url => /^\/(clients|tools)(\/|$)/.test(url.pathname), route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/clients') return reply(route, 200, [DB_CLIENT]);
    if (path.endsWith('/overview')) return reply(route, 200, answers.context);
    if (path.endsWith('/observations')) return reply(route, 200, answers.queue);
    if (path === '/tools/execute') { const { status, body } = answers.evidence(); return reply(route, status, body); }
    return route.fulfill({ status: 404, body: '' });
  });
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /DB client/ }).click();
  return { seen, messages };
}
const ALERT_BUTTON = 'Read the stored Atera alert list and find this alert';
const evidenceText = (page: Page) => page.locator('#evidence-body').innerText();

test('evidence read states: OK/STALE found, empty vs truncated empty, ERROR/MISSING unavailable, unknown times; no safe error code', async ({ page }) => {
  let next: unknown = null;
  const { seen } = await serve(page, { context: dbContext(DB_CLIENT.id, WS), queue: obsPage(journeyItems()), evidence: () => ({ status: 201, body: next }) });
  await page.locator('#queue-body .obs').filter({ hasText: 'Disk usage high' }).click();
  const cases: [string, unknown, RegExp[], RegExp[]][] = [
    ['OK found', resourceView('OK', [snapshotAlert('alert-0'), snapshotAlert('alert-1', { severity: 'HIGH' })]),
      [/OK — Stored read within its freshness limit/, /Stored alert alert-1/, /Urgent: source severity HIGH/, /matching the selected source ID exactly: 1 of 2/], [/alert-0 \(synthetic\)/]],
    ['STALE found', resourceView('STALE', [snapshotAlert('alert-1')]), [/STALE — STALE stored read/, /Stored alert alert-1/], [/Not in this stored read/]],
    ['OK empty', resourceView('OK', [snapshotAlert('alert-0')]), [/^Not in this stored read\.$/m], [/may exist beyond it/, /Stored alert/]],
    ['STALE truncated empty', resourceView('STALE', [], { truncated: true }), [/more source items exist/, /Not in this stored read\. The read was bounded \(truncated\), so the object may exist beyond it\./],
      [/No stored items/]],
    ['ERROR', resourceView('ERROR', null), [/ERROR — Stored read unavailable \(ERROR\)\. This is not an empty result\./], [/Not in this stored read/, /No stored items/]],
    ['MISSING', resourceView('MISSING', null, { asOf: null, lastSuccessAt: null }), [/MISSING — No stored read available/, /Stored read as of\s*unknown/, /Last successful read\s*unknown/],
      [/Not in this stored read/]]
  ];
  for (const [name, body, present, absent] of cases) {
    next = body;
    await page.getByRole('button', { name: ALERT_BUTTON }).click();
    await expect(page.locator('#evidence-body'), name).toContainText('Result of');
    const text = await evidenceText(page);
    for (const p of present) expect(text, `${name}: ${p}`).toMatch(p);
    for (const a of absent) expect(text, `${name}: ${a}`).not.toMatch(a);
    expect(text, name).not.toContain('SAFE-CODE-SENTINEL');
    expect(text, name).toContain('not one atomic snapshot');
  }
  expect(apiRequests(seen).filter(r => r.path === '/tools/execute').length).toBe(cases.length);
});

test('injected HTML, script, URL and CSS in every displayed field stay inert text: no element, attribute, link or execution', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:alert(1)">x</a></style><style>body{display:none}</style>https://evil.invalid/p?q=1';
  const context = mutate(dbContext(DB_CLIENT.id, WS), c => {
    c.clientName = evil; c.people[0].displayName = evil; c.devices[0].hostname = evil;
    c.resources[0].items[0].title = evil; c.resources[0].items[0].status = evil; c.resources[0].items[0].priority = evil;
  });
  const items = [observation('obs-evil', { summary: evil, reasonCodes: [evil], revision: evil, conflictOfEventKey: evil, externalEventId: 'alert-1' }),
    observation('obs-badref', { connectionId: evil, summary: 'Bad reference (synthetic)' })];
  const { messages, seen } = await serve(page, { context, queue: obsPage(items),
    evidence: () => ({ status: 201, body: resourceView('OK', [snapshotAlert('alert-1', { title: evil, status: evil, priority: evil })]) }) });
  await page.locator('#queue-body .obs').first().click();
  await page.getByRole('button', { name: ALERT_BUTTON }).click();
  await expect(page.locator('#evidence-body')).toContainText('https://evil.invalid/p?q=1');
  for (const summary of await page.locator('#context-panel summary').all()) await summary.click();
  await page.locator('#queue-body .obs').filter({ hasText: 'Bad reference' }).click();
  await expect(page.locator('#evidence-action')).toContainText('not in an accepted format');
  const probe = await page.evaluate(() => ({
    pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
    bodyElements: [...document.body.querySelectorAll('img:not(.brand-logo), script, style, a:not(.skip-link), iframe, object, embed, link, svg, form:not(.connect-form):not(.queue-filters)')].map(e => e.tagName),
    attributes: [...document.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.value)).filter(v => /evil|onerror|javascript:|<|pwned/.test(v)),
    skipLink: [...document.querySelectorAll('a')].map(a => a.getAttribute('href')),
    images: [...document.querySelectorAll('img')].map(i => i.getAttribute('src')),
    display: getComputedStyle(document.body).display,
    text: document.body.textContent ?? ''
  }));
  expect(probe.pwned).toBeNull();
  expect(probe.bodyElements).toEqual([]);
  expect(probe.skipLink, 'the only link is the static skip link').toEqual(['#main']);
  expect(probe.images, 'the only image is the static brand logo').toEqual(['vardahei-it-logo.png']);
  expect(probe.attributes).toEqual([]);
  expect(probe.display).toBe('block');
  expect(probe.text.split('<script>window.__pwned=2</script>').length - 1).toBeGreaterThanOrEqual(8);
  expect(messages).toEqual([]);
  expect(apiRequests(seen).filter(r => r.path === '/tools/execute').length, 'a malformed source reference makes no request').toBe(1);
});

test('source urgency survives low confidence, MONITOR route and a NORMAL priority label; entity labels are confirmed-only', async ({ page }) => {
  const items = [...journeyItems(), observation('obs-ghost', { entityId: 'd-404', summary: 'Unknown entity (synthetic)' }),
    observation('obs-low', { severity: 'LOW', summary: 'Low (synthetic)' })];
  await serve(page, { context: dbContext(DB_CLIENT.id, WS), queue: obsPage(items), evidence: () => ({ status: 201, body: resourceView('OK', []) }) });
  const rows = page.locator('#queue-body .obs');
  await expect(rows.filter({ hasText: 'credential theft' })).toContainText('Urgent: source severity CRITICAL');
  await expect(rows.filter({ hasText: 'credential theft' })).toContainText('Priority NORMAL');
  await expect(rows.filter({ hasText: 'Low (synthetic)' })).not.toContainText('Urgent');
  await rows.filter({ hasText: 'credential theft' }).click();
  const detail = page.locator('#detail-body');
  for (const text of ['Urgent: source severity CRITICAL', 'regardless of confidence, route or priority label', '5% (explanatory only; it never lowers source urgency)',
    'MONITOR', 'Confirmed device: HOST-01 via atera agent agent-1; stored person reference: Person (synthetic)',
    'Conflicting revision of stored event key-earlier (text reference only)', 'Superseded by observation obs-newer (text reference only)']) await expect(detail).toContainText(text);
  await rows.filter({ hasText: 'Unknown entity' }).click();
  await expect(detail).toContainText('Reference unavailable: this context cannot confirm the stored entity reference. Nothing is inferred from names or hostnames. Stored reference d-404.');
  await rows.filter({ hasText: 'Ticket (synthetic)' }).click();
  await expect(detail).toContainText('Unresolved: this observation is not linked to a known person or device.');
  await expect(detail).toContainText('ACKNOWLEDGED');
  expect(await page.locator('#workspace a').count()).toBe(0);
});

test('malformed or mismatched queue/evidence answers clear the panel with a fixed code, no echo; explicit retry recovers', async ({ page }) => {
  let queue: unknown = obsPage(journeyItems());
  let evidence = { status: 201, body: resourceView('OK', [snapshotAlert('alert-1')]) as unknown };
  const answers = { context: dbContext(DB_CLIENT.id, WS), get queue() { return queue; }, evidence: () => evidence };
  const { seen } = await serve(page, answers);
  await page.locator('#queue-body .obs').filter({ hasText: 'Disk usage high' }).click();
  for (const [name, status, body, code] of [
    ['200 instead of 201', 200, resourceView('OK', [snapshotAlert('alert-1')]), 'HTTP_ERROR'], ['other connection', 201, resourceView('OK', [], { connectionId: 'conn-other' }), 'RESPONSE_INVALID'],
    ['FIXTURE in db mode', 201, resourceView('FIXTURE', []), 'RESPONSE_INVALID'], ['body echo', 500, 'SERVER-SENTINEL', 'HTTP_ERROR'],
    ['bad item', 201, resourceView('OK', [{ anything: 'SERVER-SENTINEL' }]), 'RESPONSE_INVALID']
  ] as [string, number, unknown, string][]) {
    evidence = { status, body };
    await page.getByRole('button', { name: /^(Read the stored Atera alert list|Retry evidence)/ }).first().click();
    await expect(page.locator('#evidence-status'), name).toHaveText(`Evidence unavailable (${code}).`);
    expect(await evidenceText(page), name).not.toContain('SENTINEL');
  }
  evidence = { status: 201, body: resourceView('OK', [snapshotAlert('alert-1')]) };
  await page.getByRole('button', { name: 'Retry evidence' }).click();
  await expect(page.locator('#evidence-body')).toContainText('Stored alert alert-1');
  queue = obsPage([observation('dup'), observation('dup')]);
  await page.getByRole('button', { name: 'Refresh queue' }).click();
  await expect(page.locator('#queue-status')).toHaveText('Queue unavailable (RESPONSE_INVALID).');
  await expect(page.locator('#queue-body .obs')).toHaveCount(0);
  await expect(page.locator('#evidence-panel')).toBeHidden();
  queue = obsPage([observation('other-client', {}, 'c-two')]);
  await page.getByRole('button', { name: 'Retry queue' }).click();
  await expect(page.locator('#queue-status')).toHaveText('Queue unavailable (RESPONSE_INVALID).');
  queue = obsPage(journeyItems());
  await page.getByRole('button', { name: 'Retry queue' }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  const allowed = /^(GET \/clients|GET \/clients\/c-db\/(overview|observations\?.+)|POST \/tools\/execute)$/;
  expect(apiRequests(seen).filter(r => !allowed.test(`${r.method} ${r.path}`))).toEqual([]);
});
