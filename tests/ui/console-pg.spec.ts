import { test, expect } from '@playwright/test';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, NOTHING_RETAINED, recordRequests, startConsoleApi, submitToken, tokenRetained } from '../support/operator-ui.ts';

// S5-A browser journeys against the compiled API in ATLAS_MODE=db on a disposable PostgreSQL 17 database (A4): stored
// valid/unknown/revoked/expired tokens, an actor without clients, and a membership removed between listing and
// selecting — the server's 403 (with its existing security audit) drives the console's scope reset. Requires
// ATLAS_PG_ADMIN_URL (npm run test:ui under the PG wrapper); everything is synthetic and dropped afterwards.
const tech = generateToken(); const lonely = generateToken(); const revoked = generateToken(); const expired = generateToken(); const shifting = generateToken();
let pgdb: PgTestDatabase;
let api: ApiProcess & { console: string };

test.beforeAll(async () => {
  pgdb = await createTestDatabase();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: tech });
  await pgdb.owner.query(`
    INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)');
    INSERT INTO "Actor" ("workspaceId","id","displayName","workspacePermissions") VALUES
      ('demo-vardahei','demo-lonely','Actor without clients (synthetic)',ARRAY[]::text[]),
      ('demo-vardahei','demo-shifting','Actor losing a membership (synthetic)',ARRAY[]::text[]);
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES
      ('demo-vardahei','demo-other','demo-technician',ARRAY['context:read']),
      ('demo-vardahei','demo-gasta','demo-shifting',ARRAY['context:read']),
      ('demo-vardahei','demo-other','demo-shifting',ARRAY['context:read']);
    INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","revokedAt","createdAt","expiresAt") VALUES
      ('demo-vardahei','t-lonely','demo-lonely','${hashToken(lonely)}',NULL,now(),NULL),
      ('demo-vardahei','t-shifting','demo-shifting','${hashToken(shifting)}',NULL,now(),NULL),
      ('demo-vardahei','t-revoked','demo-technician','${hashToken(revoked)}',now(),now(),NULL),
      ('demo-vardahei','t-expired','demo-technician','${hashToken(expired)}',NULL,now() - interval '2 hours',now() - interval '1 minute');`);
  api = await startConsoleApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });
});
test.afterAll(async () => { await api?.stop(); await pgdb?.drop(); });

const count = async (table: string) => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);

test('valid stored token: authorized clients in server order, explicit selection, DB context validated, no new audit writes', async ({ page, context }) => {
  const audits = await count('AuditEvent'); const security = await count('SecurityAuditEvent');
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  await submitToken(page, tech);
  await expect(page.locator('#client-list button')).toHaveCount(2);
  await expect(page.locator('#client-list .client-name')).toHaveText(['Gasta (synthetic)', 'Other client (synthetic)']);
  await expect(page.locator('#scope-panel h1')).toHaveText('No client selected');
  await page.getByRole('button', { name: /Other client/ }).click();
  await expect(page.locator('#scope-panel')).toContainText('Client context received and validated');
  await expect(page.locator('#mode-badge')).toHaveText('Database-backed context');
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#scope-panel h1')).toHaveText('Gasta (synthetic)');
  await expect(page.locator('#scope-panel')).toContainText('validated');
  await expect(page.locator('#queue-status')).toContainText('Page 1');
  const queue = 'status=OPEN%2CACKNOWLEDGED&severity=INFO%2CLOW%2CMEDIUM%2CHIGH%2CCRITICAL&limit=25';
  expect(apiRequests(seen).map(r => `${r.method} ${r.path}`)).toEqual(['GET /clients', 'GET /clients/demo-other/overview', `GET /clients/demo-other/observations?${queue}`,
    'GET /clients/demo-gasta/overview', `GET /clients/demo-gasta/observations?${queue}`]);
  expect(apiRequests(seen).every(r => r.bearerIs(tech))).toBe(true);
  expect(await tokenRetained(page, context, tech)).toEqual(NOTHING_RETAINED);
  expect([await count('AuditEvent'), await count('SecurityAuditEvent')]).toEqual([audits, security]);
  // S5-B renders the allowlisted context: the person's display name, never the stored e-mail address.
  await expect(page.locator('#context-panel')).toContainText('Kari (synthetic)');
  expect(await page.locator('body').innerText()).not.toContain('example.invalid');
});

test('unknown, revoked and expired stored tokens are a 401 disconnect after exactly one request each', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  for (const token of [generateToken(), revoked, expired]) {
    await submitToken(page, token);
    await expect(page.locator('#connect-notice')).toContainText('The API did not accept the token');
    await expect(page.locator('#session-status')).toHaveText('Not connected');
  }
  expect(apiRequests(seen).map(r => r.path)).toEqual(['/clients', '/clients', '/clients']);
});

test('an actor without clients gets an explicit empty state, not an authentication failure', async ({ page }) => {
  await page.goto(api.console);
  await submitToken(page, lonely);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await expect(page.locator('#clients-status')).toHaveText('No clients are available to this token.');
  await expect(page.locator('#client-list button')).toHaveCount(0);
});

test('membership removed after listing: server 403 + security audit; console clears scope and refreshes the picker once', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  await submitToken(page, shifting);
  await expect(page.locator('#client-list button')).toHaveCount(2);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#scope-panel')).toContainText('validated');
  await pgdb.owner.query(`DELETE FROM "ClientMembership" WHERE "actorId" = 'demo-shifting' AND "clientId" = 'demo-other'`);
  const before = await count('SecurityAuditEvent');
  await page.getByRole('button', { name: /Other client/ }).click();
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#scope-panel h1')).toHaveText('No client selected');
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await expect(page.locator('#client-list .client-name')).toHaveText(['Gasta (synthetic)']);
  await expect(page.locator('#mode-badge')).toBeHidden();
  await page.waitForTimeout(300);
  expect(apiRequests(seen).map(r => r.path.split('?')[0])).toEqual(['/clients', '/clients/demo-gasta/overview', '/clients/demo-gasta/observations',
    '/clients/demo-other/overview', '/clients']);
  const denied = await pgdb.owner.query(`SELECT "actorId","eventType","requestedClientId" FROM "SecurityAuditEvent" ORDER BY "recordedAt" DESC LIMIT 1`);
  expect(await count('SecurityAuditEvent')).toBe(before + 1);
  expect(denied.rows[0]).toEqual({ actorId: 'demo-shifting', eventType: 'client.overview_denied', requestedClientId: 'demo-other' });
});
