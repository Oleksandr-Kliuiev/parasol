import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BUSINESS_TABLES, addActor, askDatabase, count, digest } from '../support/ask-pg.ts';
import type { AskDb, AskProcess } from '../support/ask-pg.ts';
import { NOTHING_RETAINED, askRequests, recordRequests, submitToken, tokenRetained } from '../support/operator-ui.ts';
import { QUESTION_MARKER, askPosts, askQuestion, startAskConsole } from '../support/operator-ask-ui.ts';

// ASK-B Q2/Q5/Q8 browser journey against the compiled API in ATLAS_MODE=db, ATLAS_ASK_MODE=mock on a disposable PostgreSQL 17
// database (accepted ASK-A seed: synthetic rows only). Actual current bearer/membership authority, scoped source read,
// MOCK planner/compiler and the final client audit; the console validates and renders. No HTTP mock: these are the
// authorization/audit claims (HTTP mocks qualify only transport/race probes). Each test uses its own synthetic actor, so
// the per-actor rolling budget is never shared. Requires ATLAS_PG_ADMIN_URL (npm run test:ui under the PG wrapper).
let db: AskDb;
let api: AskProcess & { console: string };
test.beforeAll(async () => {
  db = await askDatabase();
  api = await startAskConsole({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: db.pgdb.runtimeUrl, ATLAS_ASK_MODE: 'mock' });
});
test.afterAll(async () => { await api?.stop(); await db?.pgdb.drop(); });

const owner = () => db.pgdb.owner;
const answer = (page: Page) => page.locator('#ask-answer');
const row = (page: Page, summary: string) => page.locator('#queue-body .obs').filter({ hasText: summary });
async function open(page: Page, token: string) {
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#queue-status')).toContainText('Page 1:');
  await expect(page.locator('#ask-question')).toBeVisible();
}
/** Asks and returns the displayed server correlation ID of the answer. */
async function asked(page: Page, question: string, focus: boolean, heading: string): Promise<string> {
  await askQuestion(page, question, focus);
  await expect(answer(page).locator('h3')).toHaveText(heading);
  return (await answer(page).locator('dt', { hasText: 'Correlation ID' }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
}

test('DB free-input journey: summary, urgency, source-read states, entities, insufficient and unsupported; exact audit rows, no other writes', async ({ page, context }) => {
  const token = await addActor(owner(), 'askb-ui-reader', ['context:read']);
  const before = Object.fromEntries(await Promise.all(BUSINESS_TABLES.map(async t => [t, await digest(owner(), t)])));
  const [audits, security] = [await count(owner(), 'AuditEvent'), await count(owner(), 'SecurityAuditEvent')];
  const seen = recordRequests(page, api.base);
  const posts = askPosts(page);
  await open(page, token);
  const correlations: string[] = [];

  correlations.push(await asked(page, 'What needs attention?', false, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('Recorded observation: Credential theft suspected (synthetic)');
  await expect(answer(page).locator('.ask-urgent')).toContainText('Urgent: source severity CRITICAL: Credential theft suspected (synthetic)');
  await expect(answer(page).locator('.ask-urgent')).toContainText('Urgent: source severity HIGH: Disk almost full (synthetic)');
  await expect(answer(page)).not.toContainText('Resolved disk alert (synthetic)');
  await expect(answer(page)).not.toContainText('Synthetic fixture data');

  await row(page, 'Credential theft suspected').click();
  correlations.push(await asked(page, 'Почему это срочно?', true, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL');
  correlations.push(await asked(page, 'Which device is confirmed?', true, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('Confirmed device:');
  await expect(answer(page).locator('.ask-claims')).toContainText('exact graph ID demo-device-07 with a confirmed atera agent link');
  correlations.push(await asked(page, 'How fresh is the evidence?', true, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('huntress incident on connection demo-huntress-connection: MISSING — No stored read available (MISSING). This is not an empty result.');

  await row(page, 'Disk almost full').click();
  correlations.push(await asked(page, 'насколько свежи данные', true, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('atera alert on connection atera-two: ERROR — Stored read unavailable (ERROR). This is not an empty result.');
  await row(page, 'Ticket about a user').click();
  correlations.push(await asked(page, 'Which device is confirmed?', true, 'Answer from stored evidence'));
  await expect(answer(page).locator('.ask-claims')).toContainText('Unresolved: no confirmed person or device link');
  await row(page, 'Odd resource type').click();
  correlations.push(await asked(page, 'How fresh is the evidence?', true, 'Insufficient stored evidence'));
  await expect(answer(page).locator('.ask-urgent')).toContainText('Credential theft suspected (synthetic)');
  correlations.push(await asked(page, `What is the root cause? ${QUESTION_MARKER}`, true, 'Unsupported question'));

  // Exactly one ask.completed audit row per answered question, correlated with what the console displayed.
  const rows = (await owner().query(`SELECT "eventType", "correlationId", "actorId", "clientId", metadata FROM "AuditEvent" ORDER BY "recordedAt"`)).rows.slice(audits);
  expect(rows.map(r => [r.eventType, r.actorId, r.clientId])).toEqual(correlations.map(() => ['ask.completed', 'askb-ui-reader', 'demo-gasta']));
  expect(rows.map(r => r.correlationId).sort()).toEqual([...correlations].sort());
  expect(rows.map(r => r.metadata.outcome)).toEqual(['ANSWER', 'ANSWER', 'ANSWER', 'ANSWER', 'ANSWER', 'ANSWER', 'INSUFFICIENT', 'UNSUPPORTED']);
  expect(rows.every(r => Object.keys(r.metadata).sort().join() === 'itemCount,outcome,provider,ruleVersion' && r.metadata.provider === 'fixture'
    && r.metadata.ruleVersion === 'ask-mock-v1')).toBe(true);
  expect(await count(owner(), 'SecurityAuditEvent')).toBe(security);
  // No ToolExecution, DecisionRun, action or business-table change; the question exists nowhere in the database or the logs.
  expect(Object.fromEntries(await Promise.all(Object.keys(before).map(async t => [t, await digest(owner(), t)])))).toEqual(before);
  for (const table of ['AuditEvent', 'SecurityAuditEvent', 'ToolExecution', 'DecisionRun']) {
    const text = (await owner().query(`SELECT coalesce(string_agg(t::text, '|'), '') AS all FROM "${table}" t`)).rows[0].all as string;
    expect(text.includes(QUESTION_MARKER) || /needs attention|root cause|срочно/i.test(text), table).toBe(false);
  }
  expect(api.output().includes(QUESTION_MARKER)).toBe(false);
  expect(posts.map(p => p.question)).toEqual(['What needs attention?', 'Почему это срочно?', 'Which device is confirmed?', 'How fresh is the evidence?',
    'насколько свежи данные', 'Which device is confirmed?', 'How fresh is the evidence?', `What is the root cause? ${QUESTION_MARKER}`]);
  expect(askRequests(seen).filter(r => r.path === '/ask/capabilities')).toHaveLength(1);
  expect(seen.filter(r => !r.path.startsWith('/operator/')).every(r => r.sameOrigin && r.bearerIs(token)
    && (r.method === 'GET' ? /^\/(clients(\/demo-gasta\/(overview|observations\?.+))?|ask\/capabilities)$/.test(r.path) : r.path === '/clients/demo-gasta/ask'))).toBe(true);
  expect(await page.content()).not.toContain(QUESTION_MARKER);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
});

test('membership removed before asking: server 403 with one workspace denial and no client audit; full console scope reset, one picker refresh', async ({ page }) => {
  const token = await addActor(owner(), 'askb-ui-removed', ['context:read']);
  const seen = recordRequests(page, api.base);
  await open(page, token);
  await row(page, 'Credential theft suspected').click();
  await owner().query(`DELETE FROM "ClientMembership" WHERE "actorId" = 'askb-ui-removed'`);
  const audits = await count(owner(), 'AuditEvent');
  await askQuestion(page, 'Why is this urgent?', true);
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#clients-status')).toHaveText('No clients are available to this token.');
  await page.waitForTimeout(300);
  expect(seen.filter(r => !r.path.startsWith('/operator/')).map(r => `${r.method} ${r.path.split('?')[0]}`).sort()).toEqual(['GET /ask/capabilities', 'GET /clients', 'GET /clients',
    'GET /clients/demo-gasta/observations', 'GET /clients/demo-gasta/overview', 'POST /clients/demo-gasta/ask'].sort());
  expect(await count(owner(), 'AuditEvent')).toBe(audits);
  const denied = (await owner().query(`SELECT "actorId","eventType","requestedClientId","reasonCode",metadata FROM "SecurityAuditEvent" WHERE "actorId" = 'askb-ui-removed'`)).rows;
  expect(denied).toEqual([{ actorId: 'askb-ui-removed', eventType: 'ask.scope_denied', requestedClientId: 'demo-gasta', reasonCode: 'SCOPE_DENIED', metadata: {} }]);
});

test('token revoked before asking: server 401 disconnects the console and clears every region; no audit row', async ({ page, context }) => {
  const token = await addActor(owner(), 'askb-ui-revoked', ['context:read']);
  await open(page, token);
  await askQuestion(page, 'What needs attention?');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await owner().query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'token-askb-ui-revoked'`);
  const [audits, security] = [await count(owner(), 'AuditEvent'), await count(owner(), 'SecurityAuditEvent')];
  await askQuestion(page, 'What needs attention?');
  await expect(page.locator('#connect-notice')).toContainText('The API did not accept the token');
  await expect(page.locator('#ask-panel')).toBeHidden();
  expect(await answer(page).innerHTML()).toBe('');
  expect([await count(owner(), 'AuditEvent'), await count(owner(), 'SecurityAuditEvent')]).toEqual([audits, security]);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
});
