import { expect, test } from '@playwright/test';
import { employee, fixture, json, staffContext, workspace } from './support';
import { parseObservationQueue } from '../src/features/parasol/observationQueueContract';
import { severities } from '../src/features/parasol/technicalContract';

test('real restricted runtimes expose forty scoped customers and four hundred registered devices', async ({ page, browser }) => {
  const f = fixture();
  const anonymous = await browser.newContext({ baseURL: f.baseUrl, ignoreHTTPSErrors: true });
  try {
    expect((await anonymous.request.get(`/api/v1/parasol/customers/${f.target.customerId}/workspace`)).status(), 'Anonymous CRM technical read').toBe(401);
    expect((await anonymous.request.get(new URL('clients', f.atlasUrl).href)).status(), 'Anonymous actual Atlas read').toBe(401);
  } finally { await anonymous.close(); }
  const admin = await staffContext(browser, 'Crm.Admin');
  const technician = await staffContext(browser, 'Crm.Technician');
  const lead = await staffContext(browser, 'Crm.ServiceLead');
  try {
    const directory = await json(await admin.page.request.get('/api/v1/parasol/customer-identities/atlas-export'), 'Real Atlas customer directory') as {
      status: string; snapshot: { schemaVersion: number; source: string; workspaceId: string; clients: { clientId: string; name: string }[] };
    };
    expect(directory.status).toBe('READY'); expect(directory.snapshot.schemaVersion).toBe(1); expect(directory.snapshot.source).toBe('atlas');
    expect(directory.snapshot.workspaceId).toBe(f.workspaceId); expect(directory.snapshot.clients.length).toBe(40);
    expect(new Set(directory.snapshot.clients.map(c => c.clientId)).size, 'Distinct real scoped directory rows').toBe(40);
    expect(directory.snapshot.clients.every(c => employee('Crm.Admin').visibleClientIds.includes(c.clientId)), 'No foreign workspace client in directory').toBe(true);
    expect(directory.snapshot.clients.every(c => Object.keys(c).sort().join(',') === 'clientId,name'), 'Closed identity projection').toBe(true);
    // Every count comes through the actual Web/BFF -> Atlas -> restricted PostgreSQL chain, with bounded parallelism.
    for (const [role, session, expectedClients] of [
      ['Crm.Admin', admin, f.clients], ['Crm.Technician', technician, f.clients.slice(0, 20)], ['Crm.ServiceLead', lead, f.clients.slice(20)],
    ] as const) {
      const expectedIds = expectedClients.map(c => c.atlasClientId); const visible = new Set(expectedIds);
      expect([...employee(role).visibleClientIds].sort(), `${role}: manifest agrees with the independent, disjoint fixture matrix`).toEqual([...expectedIds].sort());
      let readable = 0; let knownDevices = 0;
      for (let offset = 0; offset < f.clients.length; offset += 4) {
        const clients = f.clients.slice(offset, offset + 4);
        const batch = await Promise.all(clients.map(c => workspace(session.page, c.crmCustomerId)));
        for (const [index, current] of batch.entries()) {
          const permitted = visible.has(clients[index]!.atlasClientId);
          expect(current.status, `${role}: each mapped customer uses this employee's actual Atlas permission`).toBe(permitted ? 'READY' : 'ACCESS_DENIED');
          if (permitted) {
            expect(current.summary?.mode).toBe('db'); expect(current.summary?.knownDevices).toBe(10);
            readable++; knownDevices += current.summary!.knownDevices;
          } else expect(current.summary, 'Denied customers disclose no technical summary').toBeNull();
        }
      }
      expect(readable, `${role}: exact real forty-customer access matrix`).toBe(expectedClients.length);
      expect(knownDevices, `${role}: devices visible through permitted customers only`).toBe(expectedClients.length * 10);
    }
    expect((await technician.page.request.get('/api/v1/parasol/customer-identities/atlas-export')).status(), 'Directory export also enforces its CRM role').toBe(403);
  } finally { await lead.context.close(); await technician.context.close(); await admin.context.close(); }
  // The test's default page also remains anonymous: sessions were never shared between employees.
  expect((await page.request.get('/bff/user')).status()).toBe(401);
});

test('actual customer cards retain source provenance, exact device links and six queue pages including history', async ({ browser }) => {
  const f = fixture(); const admin = await staffContext(browser, 'Crm.Admin', `/organizations/${f.target.customerId}`);
  try {
    const view = await workspace(admin.page, f.target.customerId); const summary = view.summary;
    expect(view.status).toBe('READY'); expect(summary?.knownDevices).toBe(10); expect(summary?.activeObservations).toBe(126);
    expect(summary?.observationPage.items.length).toBe(100); expect(summary?.observationPage.truncated).toBe(true);
    expect(summary?.observationPage.items[0]?.id, 'Older Critical remains ahead of newer Medium observations').toBe(f.target.criticalObservationId);
    expect(summary?.observationPage.items.some(o => o.id === f.target.observationIdOutsideFirst100), 'Exact handoff target is genuinely outside overview').toBe(false);
    const confirmed = summary?.observationPage.items.find(o => o.id === f.target.criticalObservationId);
    expect(confirmed?.source, 'Positive Huntress source control').toBe('huntress');
    expect(confirmed?.deviceStatus, 'Confirmed Huntress link resolves the exact registered device').toBe('CONFIRMED');
    expect(confirmed?.deviceId).toBe(f.target.confirmedDeviceId);
    const unconfirmed = summary?.observationPage.items.find(o => o.id === f.target.unconfirmedObservationId);
    expect(unconfirmed?.deviceStatus, 'A hostname alone cannot confirm a Huntress association').toBe('UNAVAILABLE');
    expect(unconfirmed?.deviceId).toBeNull();
    expect(summary?.resources.some(r => r.status === 'STALE'), 'Persisted source freshness is genuinely stale').toBe(true);
    expect(summary?.resources.some(r => r.status === 'MISSING'), 'Missing coverage is not rendered as healthy').toBe(true);
    const panel = admin.page.getByRole('region', { name: 'Technical workspace · Atlas' });
    await expect(panel.getByText(/Only the first 100 of 126 active observations are loaded/)).toBeVisible();
    const active = panel.getByRole('region', { name: 'Active Atlas observations', exact: true });
    await expect(active.getByRole('listitem').first().getByText(f.target.criticalSummary, { exact: true })).toBeVisible();
    await active.getByRole('searchbox').fill(f.target.unconfirmedSummary);
    await expect(active.getByText('No confirmed device for this source in the current registry', { exact: true })).toBeVisible();
    await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
    const devices = panel.getByRole('region', { name: 'Atlas devices', exact: true });
    await expect(devices.getByRole('listitem')).toHaveCount(10);
    await expect(devices.getByText(f.target.duplicateHostname, { exact: true })).toHaveCount(2);
    await expect(devices.getByText(`Atlas device ID: ${f.target.confirmedDeviceId}`, { exact: true })).toBeVisible();
    await expect(devices.getByText(`Atlas device ID: ${f.target.unconfirmedDeviceId}`, { exact: true })).toBeVisible();
    const queue = panel.getByRole('region', { name: 'Observation queue and history', exact: true });
    const readQueuePage = async (cursor: string | null, action: () => Promise<void>) => {
      const responsePending = admin.page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === `/api/v1/parasol/customers/${f.target.customerId}/observations`
          && url.searchParams.get('severity') === 'ALL' && url.searchParams.get('status') === 'ACTIVE' && url.searchParams.get('cursor') === cursor;
      });
      await action(); const response = await responsePending;
      expect(response.status(), 'Actual queue BFF response').toBe(200);
      const result = parseObservationQueue(await response.json(), f.target.customerId, { severity: 'ALL', status: 'ACTIVE', cursor });
      expect(result.status, 'Closed actual queue projection').toBe('READY');
      if (!result.queue) throw new Error('The real queue returned no validated page.');
      expect(result.queue.total).toBe(126); expect(result.queue.severityCounts).toEqual(f.target.severityCounts);
      return result.queue;
    };
    let current = await readQueuePage(null, () => panel.getByRole('tab', { name: 'Observation queue and history', exact: true }).click());
    await expect(queue.getByText('Matching observations across Atlas: 126', { exact: true })).toBeVisible();
    const observations: { id: string; severity: string }[] = [];
    for (let number = 1; number <= 6; number++) {
      if (number > 1) {
        expect(current.nextCursor !== null, 'Every non-terminal page provides its real continuation').toBe(true);
        current = await readQueuePage(current.nextCursor, () => queue.getByRole('button', { name: 'Next page', exact: true }).click());
      }
      await expect(queue.getByText(`Page ${number} · ${number === 6 ? 1 : 25} records loaded`, { exact: true })).toBeVisible();
      await expect(queue.getByRole('listitem')).toHaveCount(current.items.length);
      const rows = await queue.getByRole('listitem').allTextContents();
      expect(current.items.every((item, index) => rows[index]?.includes(item.summary)), 'Each actual queue page replaces the UI with its own source rows').toBe(true);
      observations.push(...current.items.map(({ id, severity }) => ({ id, severity })));
    }
    expect(observations.length, 'All six actual BFF pages contain the full active queue').toBe(126);
    expect(new Set(observations.map(o => o.id)).size, 'No repeated or skipped active observation across pages').toBe(126);
    expect(Object.fromEntries(severities.map(s => [s, observations.filter(o => o.severity === s).length])), 'Actual six-page severity histogram').toEqual(f.target.severityCounts);
    expect(observations[0]?.id).toBe(f.target.criticalObservationId);
    expect(current.items.map(({ id, severity }) => ({ id, severity })), 'Exact final low-severity observation').toEqual([{ id: f.target.observationIdOutsideFirst100, severity: 'LOW' }]);
    expect(current.nextCursor, 'The sixth actual page is terminal').toBeNull();
    await expect(queue.getByText(f.target.observationSummaryOutsideFirst100, { exact: true })).toBeVisible();
    await expect(queue.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await queue.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(queue.getByText('Page 5 · 25 records loaded', { exact: true })).toBeVisible();
    await queue.getByLabel('Queue severity', { exact: true }).selectOption('LOW');
    await expect(queue.getByText('Matching observations across Atlas: 1', { exact: true })).toBeVisible();
    await expect(queue.getByText('Page 1 · 1 records loaded', { exact: true })).toBeVisible();
    await queue.getByRole('button', { name: 'Reset filters', exact: true }).click();
    await expect(queue.getByText('Page 1 · 25 records loaded', { exact: true })).toBeVisible();
    for (const [state, text] of [['RESOLVED', f.target.resolvedSummary], ['SUPPRESSED', f.target.suppressedSummary]]) {
      await queue.getByLabel('Queue state', { exact: true }).selectOption(state!);
      await expect(queue.getByText(text!, { exact: true })).toBeVisible();
      await expect(queue.getByRole('button', { name: 'Assign work', exact: true })).toHaveCount(0);
      await queue.getByRole('button', { name: 'View linked work', exact: true }).click();
      const dialog = admin.page.getByRole('dialog', { name: 'Assign observation work', exact: true });
      await expect(dialog.getByText(/No new task can be created from this observation/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  } finally { await admin.context.close(); }
});
