import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CLIENT, MARKERS, WS, askDatabase, count } from '../support/ask-pg.ts';
import type { AskDb, AskProcess } from '../support/ask-pg.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { DEFAULT_COST, KEY, Q_MARKER, ScriptedProvider, currentConsent, databaseText, envelope, ledger, remoteDatabase, response } from '../support/ask-remote-api.ts';
import type { RemoteDb } from '../support/ask-remote-api.ts';
import { startRemoteConsole } from '../support/ask-remote-console.ts';
import type { RemoteConsole } from '../support/ask-remote-console.ts';
import { NOTHING_RETAINED, recordConsole, recordRequests, submitToken, tokenRetained, waitFor } from '../support/operator-ui.ts';
import { askPosts, startAskConsole } from '../support/operator-ask-ui.ts';
import { REMOTE_BADGE, askRemote } from '../support/operator-ask-remote-ui.ts';

// ASK-REMOTE R-C browser journeys against REAL disposable PostgreSQL 17 (accepted Ask seed + ONE synthetic ACTIVE policy via
// the trusted routines) and the COMPILED production remote composition with the console, served in this process by the
// test-only ask-remote-console.ts. The provider is ONLY the accepted R-B scripted offline seam (explicit construction); a
// network trap refuses/counts any outbound request. Unlike the route-stub suites, these exercise the actual bearer/membership
// authority, consent-tuple check, reservation/settlement ledger and fixed audit. No paid call, key, account or real data.
let db: RemoteDb;
let provider: ScriptedProvider;
let server: RemoteConsole;
test.beforeAll(async () => {
  db = await remoteDatabase();
  provider = new ScriptedProvider();
  server = await startRemoteConsole(db.pgdb.runtimeUrl, provider.seams());
});
test.afterAll(async () => { await server?.close(); await db?.pgdb.drop(); });

const owner = () => db.pgdb.owner;
const answer = (page: Page) => page.locator('#ask-answer');
const row = (page: Page, summary: string) => page.locator('#queue-body .obs').filter({ hasText: summary });
const attempts = async () => (await ledger(owner(), WS)).attempts;
async function open(page: Page, token: string) {
  await page.goto(server.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#queue-status')).toContainText('Page 1:');
}

test('synthetic REMOTE journey: disclosure from the durable policy, consented V2 POST, real ledger/audit, question only in the captured synthetic request', async ({ page, context }) => {
  const seen = recordRequests(page, server.base);
  const messages = recordConsole(page);
  const posts = askPosts(page);
  const consent = await currentConsent(owner());
  const before = { captures: provider.captures.length, attempts: (await attempts()).length, audits: await count(owner(), 'AuditEvent'), security: await count(owner(), 'SecurityAuditEvent') };
  await open(page, db.tokens.both);
  await expect(page.locator('#ask-badge')).toHaveText(REMOTE_BADGE);
  await page.locator('#ask-disclosure summary').click();
  await expect(page.locator('#ask-disclosure')).toContainText(consent.admissionId);
  await expect(page.locator('#ask-disclosure')).toContainText(consent.policyVersion);
  // Unconsented: nothing is sent, nothing reserved.
  await askRemote(page, `Why is this urgent? ${Q_MARKER}`, { consent: false });
  await page.waitForTimeout(200);
  expect([posts.length, provider.captures.length]).toEqual([0, before.captures]);

  await row(page, 'Credential theft suspected').click();
  provider.next = () => response(envelope('WHY_URGENT'));
  await askRemote(page, `Why is this urgent? ${Q_MARKER}`, { focus: true });
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL');
  await expect(answer(page)).toContainText('task chosen by OpenAI GPT-6 Luna');
  provider.next = () => response(envelope('SUMMARY'));
  await page.locator('#ask-focus').uncheck();
  await askRemote(page, 'Summarize what matters here, please (synthetic)');
  await expect(answer(page).locator('.ask-claims')).toContainText('Recorded observation: Credential theft suspected (synthetic)');
  provider.next = () => response(envelope('UNSUPPORTED'));
  await askRemote(page, 'What is the root cause? (synthetic)');
  await expect(answer(page).locator('h3')).toHaveText('Unsupported question');
  await expect(answer(page).locator('.ask-urgent')).toContainText('Credential theft suspected (synthetic)');

  // Exactly one provider call per consented question; question + hasFocus only; no stored evidence on the wire.
  expect(provider.captures.length).toBe(before.captures + 3);
  const wires = provider.captures.slice(before.captures).map(c => JSON.parse(JSON.parse(c.bytes).messages[1].content));
  expect(wires).toEqual([{ question: `Why is this urgent? ${Q_MARKER}`, hasFocus: true }, { question: 'Summarize what matters here, please (synthetic)', hasFocus: false },
    { question: 'What is the root cause? (synthetic)', hasFocus: false }]);
  for (const capture of provider.captures.slice(before.captures)) {
    expect(capture.key).toBe(KEY);
    for (const marker of [MARKERS.fact, MARKERS.email, 'ask-crit', 'Credential theft', CLIENT, WS, consent.admissionId]) expect(capture.bytes.includes(marker), marker).toBe(false);
  }
  expect(posts.map(p => [p.contractVersion, p.observationId, (p.acknowledgement as any).policyVersion, (p.acknowledgement as any).admissionId]))
    .toEqual([['AskRequestV2', 'ask-crit', consent.policyVersion, consent.admissionId], ['AskRequestV2', null, consent.policyVersion, consent.admissionId],
      ['AskRequestV2', null, consent.policyVersion, consent.admissionId]]);
  expect(new Set(posts.map(p => p.requestId)).size).toBe(3);
  // Real ledger and audit: three settled verified-usage attempts; three fixed remote completion rows; no denial.
  const settled = (await attempts()).slice(before.attempts);
  expect(settled.map(a => [a.state, a.outcome, a.accounted, a.policyVersion])).toEqual(Array(3).fill(['SETTLED', 'USAGE_VERIFIED', DEFAULT_COST, consent.policyVersion]));
  const rows = (await owner().query(`SELECT "eventType", metadata FROM "AuditEvent" ORDER BY "recordedAt", id`)).rows.slice(before.audits);
  expect(rows.map(r => [r.eventType, r.metadata.provider, r.metadata.ruleVersion, r.metadata.outcome]))
    .toEqual([['ask.completed', 'openai', 'ask-remote-intent-v1', 'ANSWER'], ['ask.completed', 'openai', 'ask-remote-intent-v1', 'ANSWER'],
      ['ask.completed', 'openai', 'ask-remote-intent-v1', 'UNSUPPORTED']]);
  expect(await count(owner(), 'SecurityAuditEvent')).toBe(before.security);
  // Privacy: the question exists only in the captured synthetic request — never in the DB, page, URL or storage.
  const text = await databaseText(owner());
  for (const marker of [Q_MARKER, KEY, 'Summarize what matters', 'UPSTREAM-ID-MARKER-7f3', 'chatcmpl']) expect(text.includes(marker), marker).toBe(false);
  expect((await page.content()).includes(Q_MARKER)).toBe(false);
  expect(await tokenRetained(page, context, db.tokens.both)).toEqual(NOTHING_RETAINED);
  expect(seen.filter(r => !r.path.startsWith('/operator/')).every(r => r.sameOrigin && r.bearerIs(db.tokens.both))).toBe(true);
  expect(server.blocked()).toBe(0);
  expect(messages).toEqual([]);
});

test('actual policy revision: current 409 before any reservation; manual refresh shows the new version; new consent and UUID succeed', async ({ page }) => {
  const posts = askPosts(page);
  await open(page, db.tokens.both);
  const start = await currentConsent(owner());
  const before = { captures: provider.captures.length, attempts: (await attempts()).length };
  const revised = await revise(owner(), WS, { ownerApprovalRef: 'synthetic-owner-approval-rc' });
  await askRemote(page, 'What needs attention? (synthetic)');
  await expect(page.locator('#ask-capability')).toContainText('The remote Ask policy changed after your consent');
  await expect(page.locator('#ask-form')).toBeHidden();
  await expect(page.locator('#ask-question')).toHaveValue('');
  await expect(page.locator('#ask-consent')).not.toBeChecked();
  expect([provider.captures.length, (await attempts()).length]).toEqual([before.captures, before.attempts]);
  await page.getByRole('button', { name: 'Refresh the remote Ask disclosure' }).click();
  await expect(page.locator('#ask-form')).toBeVisible();
  await page.locator('#ask-disclosure summary').click();
  await expect(page.locator('#ask-disclosure')).toContainText(revised);
  provider.next = () => response(envelope('SUMMARY'));
  await askRemote(page, 'What needs attention? (synthetic)');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  expect(posts.map(p => (p.acknowledgement as any).policyVersion)).toEqual([start.policyVersion, revised]);
  expect(posts[0]!.requestId).not.toBe(posts[1]!.requestId);
  expect(provider.captures.length).toBe(before.captures + 1);
  expect(server.blocked()).toBe(0);
});

test('provider failures are ASK_REMOTE_UNAVAILABLE (never sign-out/scope/OFF); revoked admission is NOT_ADMITTED; actual 403 resets, 401 disconnects', async ({ page }) => {
  await open(page, db.tokens.both);
  for (const status of [429, 500, 404, 401]) {
    provider.next = () => response(Buffer.from('{"error":{"message":"SERVER-DETAIL-SENTINEL"}}'), status);
    await askRemote(page, `What needs attention? upstream ${status}`);
    await expect(page.locator('#ask-status')).toContainText('The remote interpreter was unavailable');
    await expect(answer(page).locator('code').first()).toHaveText('ASK_REMOTE_UNAVAILABLE');
    await expect(page.locator('#session-status')).toHaveText('Connected');
    await expect(page.locator('#scope-panel')).toContainText('Gasta');
    expect(await page.locator('#ask-panel').innerText()).not.toContain('SERVER-DETAIL-SENTINEL');
    if (status === 401) break;
    await expect(page.locator('#ask-form')).toBeVisible();
  }
  // The upstream 401 durably paused the policy (configuration fault): the next question's tuple is stale → 409, never OFF.
  await askRemote(page, 'What needs attention? after pause');
  await expect(page.locator('#ask-capability')).toContainText('The remote Ask policy changed');
  await page.getByRole('button', { name: 'Refresh the remote Ask disclosure' }).click();
  await expect(page.locator('#ask-capability')).toContainText('It is unavailable, not switched off');
  await expect(page.locator('#ask-panel')).toBeVisible();
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await revise(owner(), WS, { state: 'ACTIVE' });

  // Actual browser authority: the capability is workspace-informational, but the question needs context:read AND ask:remote
  // on one membership → current 403 → full scope reset and exactly one picker refresh; nothing reserved or sent.
  const denied = await page.context().newPage();
  const seen = recordRequests(denied, server.base);
  const before = [provider.captures.length, (await attempts()).length];
  await open(denied, db.tokens.context);
  await askRemote(denied, 'What needs attention? (synthetic)');
  await expect(denied.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await denied.waitForTimeout(300);
  expect(seen.filter(r => r.path === '/clients').length).toBe(2);
  expect([provider.captures.length, (await attempts()).length]).toEqual(before);
  await denied.close();
  // Token revoked → actual current 401 disconnects.
  const revoked = await page.context().newPage();
  await open(revoked, db.tokens.both);
  await waitFor(() => provider.captures.length >= before[0]!, 'ready');
  await owner().query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'token-rem-both'`);
  await askRemote(revoked, 'What needs attention? (synthetic)');
  await expect(revoked.locator('#connect-notice')).toContainText('The API did not accept the token');
  await expect(revoked.locator('#ask-panel')).toBeHidden();
  await revoked.close();
  expect(server.blocked()).toBe(0);
});

test.describe('inactive REMOTE startup (actual compiled process, production seams, no policy)', () => {
  let inactive: AskDb;
  let api: AskProcess & { console: string };
  test.beforeAll(async () => {
    inactive = await askDatabase();
    api = await startAskConsole({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: inactive.pgdb.runtimeUrl, ATLAS_ASK_MODE: 'remote' });
  });
  test.afterAll(async () => { await api?.stop(); await inactive?.pgdb.drop(); });
  test('no admission: capability 503 NOT_ADMITTED shows unavailable (not OFF), no form, nothing reserved; startup made no provider call', async ({ page }) => {
    const { addActor } = await import('../support/ask-pg.ts');
    const token = await addActor(inactive.pgdb.owner, 'rc-inactive-reader', ['context:read', 'ask:remote']);
    await page.goto(api.console);
    await submitToken(page, token);
    await page.getByRole('button', { name: /Gasta/ }).click();
    await expect(page.locator('#ask-capability')).toContainText('It is unavailable, not switched off');
    await expect(page.locator('#ask-form')).toBeHidden();
    await expect(page.locator('#ask-badge')).toHaveText('Ask Atlas — mode not confirmed');
    expect((await ledger(inactive.pgdb.owner, WS)).attempts).toEqual([]);
    expect(api.output()).toContain('Ask Atlas: REMOTE V2, policy-gated per request; no provider call at startup');
    expect(api.output().includes(token)).toBe(false);
  });
});
