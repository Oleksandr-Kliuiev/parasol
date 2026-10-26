import { expect, test } from '@playwright/test';
import { parseLocalReadiness, type ReadinessAuthority } from '../src/features/parasol/localReadinessContract';
import { assertTaskEvidence, control, fixture, staffContext, type Role } from './support';

test('local readiness reads personal configuration and stored mapping review without calling Atlas or changing work', async ({ browser, page }, testInfo) => {
  const f = fixture(); const endpoint = '/api/v1/parasol/local-readiness';
  expect((await page.request.get(endpoint)).status(), 'Anonymous local readiness').toBe(401);
  const before = control('countsTaskEvidence');
  expect(Number.isSafeInteger(before.atlasRequests) && before.atlasRequests > 0, 'The recorder observed the preceding real Atlas workflow').toBe(true);
  const cases: ReadonlyArray<readonly [Role, ReadinessAuthority, string]> = [
    ['Crm.Admin', { atlasRead: true, integrationsManage: true, customersRead: true }, 'PERSONAL_ENTRY_PRESENT'],
    ['Crm.Technician', { atlasRead: true, integrationsManage: false, customersRead: true }, 'PERSONAL_ENTRY_PRESENT'],
    ['Crm.ServiceLead', { atlasRead: true, integrationsManage: false, customersRead: true }, 'PERSONAL_ENTRY_PRESENT'],
    ['Crm.ReadOnly', { atlasRead: true, integrationsManage: false, customersRead: true }, 'PERSONAL_ENTRY_MISSING'],
  ];
  for (const [role, authority, personalStatus] of cases) {
    const session = await staffContext(browser, role, '/connections');
    try {
      const response = await session.page.request.get(endpoint);
      expect(response.status(), 'Actual local metadata endpoint').toBe(200);
      expect(response.headers()['cache-control']).toContain('no-store');
      const value: unknown = await response.json().catch(() => { throw new Error('Local readiness must return JSON.'); });
      const result = parseLocalReadiness(value, authority);
      expect(result !== null, 'Strict local metadata contract and exact permission sections').toBe(true);
      expect(result!.status).toBe('LOCAL_SNAPSHOT'); expect(result!.scope).toBe('LOCAL_ONLY');
      expect(result!.connectivity).toBe('NOT_CHECKED'); expect(result!.personalAtlas?.status).toBe(personalStatus);
      const serialized = JSON.stringify(value);
      expect([f.workspaceId, f.collisionWorkspaceId, '127.0.0.1', 'composition-client-', ...f.employees.map(e => e.id)]
        .some(forbidden => serialized.includes(forbidden)), 'No private source IDs, endpoints or employee entries in metadata').toBe(false);
      await expect(session.page.getByRole('heading', { name: 'Connection readiness', exact: true })).toBeVisible();
      await expect(session.page.getByText('Connections and credentials have not been checked.', { exact: true })).toBeVisible();
      const personal = session.page.getByRole('region', { name: 'Personal Atlas configuration', exact: true });
      await expect(personal.getByText(personalStatus === 'PERSONAL_ENTRY_PRESENT' ? 'Personal entry present' : 'Personal entry missing', { exact: true })).toBeVisible();
      if (authority.integrationsManage) {
        const admin = result!.admin!;
        expect(admin.authMode).toBe('DEVELOPMENT');
        for (const provider of [admin.atera, admin.powerOffice]) {
          expect(provider.enabled).toBe(false); expect(provider.writeEnabled).toBe(false);
          expect(provider.stored).toEqual({ paused: false, lastSucceededAt: null, records: 0, unlinkedRecords: 0, pendingOutbound: 0, failedOutbound: 0 });
        }
        expect(admin.microsoftGraph).toEqual({ enabled: false, calendarEnabled: false, mailEnabled: false,
          sharePointEnabled: false, teamsEnabled: false, stored: { directoryLastSucceededAt: null, roleLastSucceededAt: null } });
        expect(admin.huntress).toEqual({ managedBy: 'ATLAS', configuration: 'UNKNOWN', connectivity: 'NOT_CHECKED' });
        expect(admin.atlasMappings).toEqual({ status: 'CHECKED', reviewStatus: 'REQUIRED', scope: 'STORED_LOCAL_REGISTRY', limit: 500,
          coverage: { storedLinks: 40, examinedLinks: 40, omittedLinks: 0, unlinkedStoredReferences: 1 },
          counts: { validLinks: 40, invalidIdentities: 0, missingReferences: 0, goneReferences: 0, invalidReferences: 0, unavailableCustomers: 0 } });
        // The earlier foreign-workspace exercise intentionally leaves its unlinked local reference.
        const mappings = session.page.getByRole('region', { name: 'Stored Atlas mappings', exact: true });
        await expect(mappings.getByText('Stored links examined: 40 of 40 (limit 500)', { exact: true })).toBeVisible();
        await session.page.screenshot({ path: testInfo.outputPath('local-readiness-synthetic.png'), fullPage: true });
      } else {
        expect(result!.admin).toBeNull();
        await expect(session.page.getByRole('region', { name: 'Saved administrative configuration', exact: true })).toHaveCount(0);
        await expect(session.page.getByRole('region', { name: 'Stored Atlas mappings', exact: true })).toHaveCount(0);
      }
      const refresh = session.page.getByRole('button', { name: 'Refresh local readiness', exact: true });
      await refresh.focus();
      const refreshed = session.page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === endpoint);
      await session.page.keyboard.press('Enter'); expect((await refreshed).status()).toBe(200);
      await expect(personal).toBeVisible(); await expect(refresh).toBeFocused();
      await expect(session.page.getByRole('main').getByRole('button', { name: /^(test connection|sync|pause|save)$/i })).toHaveCount(0);
    } finally { await session.context.close(); }
  }
  const finance = await staffContext(browser, 'Crm.Finance', '/connections');
  try {
    expect((await finance.page.request.get(endpoint)).status(), 'Finance has neither local readiness authority').toBe(403);
    await expect(finance.page.getByRole('heading', { name: 'Connection readiness', exact: true })).toHaveCount(0);
    await expect(finance.page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  } finally { await finance.context.close(); }
  const after = control('countsTaskEvidence');
  expect(after.atlasRequests, 'Opening and manually refreshing local readiness makes no Atlas HTTP request').toBe(before.atlasRequests);
  assertTaskEvidence(after, 1, 2);
});
