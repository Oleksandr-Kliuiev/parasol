import { expect, test } from '@playwright/test';
import { parseAtlasAttention } from '../src/features/parasol/atlasAttentionContract';
import { assertTaskEvidence, control, fixture, staffContext, type StaffRole } from './support';

test('personal My Day attention reads the independent forty/twenty/twenty client sets and opens fresh urgent work without a provider write', async ({ browser, page }) => {
  const f = fixture();
  const endpoint = '/api/v1/parasol/my-day/atlas-attention';
  expect((await page.request.get(endpoint)).status(), 'Anonymous attention read').toBe(401);
  for (const [role, expectedClients, active, high, critical] of [
    ['Crm.Admin', f.clients, 165, 4, 1],
    ['Crm.Technician', f.clients.slice(0, 20), 145, 4, 1],
    ['Crm.ServiceLead', f.clients.slice(20), 20, 0, 0],
  ] as const satisfies ReadonlyArray<readonly [StaffRole, typeof f.clients, number, number, number]>) {
    const session = await staffContext(browser, role, `/organizations/${expectedClients[0]!.crmCustomerId}`);
    try {
      const pending = session.page.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === endpoint);
      await session.page.goto('/');
      const response = await pending;
      expect(response.status(), 'Actual personal My Day attention').toBe(200);
      const result = parseAtlasAttention(await response.json().catch(() => { throw new Error('Attention response must be JSON.'); }));
      expect(result.status, 'Missing/stale source coverage is not promoted to a complete healthy result').toBe('PARTIAL');
      expect(result.coverage).toEqual({
        visibleClients: expectedClients.length, matchedCustomers: expectedClients.length,
        selectedCustomers: expectedClients.length, attemptedCustomers: expectedClients.length,
        readyCustomers: expectedClients.length, failedCustomers: 0, omittedCustomers: 0,
        unmappedClients: 0, mappingIssues: 0, limitReached: false, timedOut: false,
      });
      expect(result.totals).toEqual({ activeObservations: active, high, critical });
      expect(result.customers?.map(customer => customer.customerId).sort(), 'Exact independent personal customer set')
        .toEqual(expectedClients.map(customer => customer.crmCustomerId).sort());
      expect(result.customers?.every(customer => customer.status === 'READY' && customer.mode === 'db'
        && customer.preview.length <= 3 && customer.preview.every(observation => ['HIGH', 'CRITICAL'].includes(observation.severity)))).toBe(true);
      expect(JSON.stringify(result).includes(f.workspaceId) || JSON.stringify(result).includes('composition-client-'),
        'Aggregate excludes private source workspace/client identifiers').toBe(false);
      const panel = session.page.getByRole('region', { name: 'Technical attention · Atlas', exact: true });
      await expect(panel.getByText(`Customers read successfully: ${expectedClients.length} of ${expectedClients.length} selected`, { exact: true })).toBeVisible();
      await expect(panel.getByText(`Active observations in successfully read customers: ${active} · High: ${high} · Critical: ${critical}`, { exact: true })).toBeVisible();
      if (critical) {
        const target = result.customers!.find(customer => customer.customerId === f.target.customerId)!;
        expect(target.high).toBe(4); expect(target.critical).toBe(1); expect(target.activeObservations).toBe(126);
        expect(target.preview.length).toBe(3); expect(target.preview[0]?.id).toBe(f.target.criticalObservationId);
        expect(target.preview[0]?.deviceStatus).toBe('CONFIRMED'); expect(target.preview[0]?.deviceId).toBe(f.target.confirmedDeviceId);
        expect(target.devices.some(device => device.id === f.target.confirmedDeviceId && device.sources.includes('huntress'))).toBe(true);
        expect(target.resources?.some(resource => resource.status === 'STALE')).toBe(true);
        const customer = panel.getByRole('region', { name: f.clients[0]!.name, exact: true });
        await expect(customer.getByText(f.target.criticalSummary, { exact: true })).toBeVisible();
        await expect(customer.getByText('Urgent preview: 3 of 5 active HIGH/CRITICAL observations', { exact: true })).toBeVisible();
        const row = customer.getByRole('listitem').filter({ hasText: f.target.criticalSummary });
        await row.getByRole('button', { name: 'Assign work', exact: true }).click();
        const dialog = session.page.getByRole('dialog', { name: 'Assign observation work', exact: true });
        await expect(dialog.getByText(f.target.criticalSummary, { exact: true })).toBeVisible();
        await expect(dialog.getByText('Task priority: High', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      } else expect(result.customers?.every(customer => customer.preview.length === 0)).toBe(true);
    } finally { await session.context.close(); }
  }
  const finance = await staffContext(browser, 'Crm.Finance');
  try {
    expect((await finance.page.request.get(endpoint)).status(), 'Finance has no technical attention permission').toBe(403);
    await expect(finance.page.getByRole('region', { name: 'Technical attention · Atlas', exact: true })).toHaveCount(0);
  } finally { await finance.context.close(); }
  assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
});
