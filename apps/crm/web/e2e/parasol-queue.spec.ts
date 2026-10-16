import { expect, test } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

// Only the technical BFF responses are controlled here. Backend SQL/HTTP tests independently verify scope and cursors.
test('full queue pages and server filters reach observations beyond the overview limit', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Queue ') });
  const overview = atlasWorkspace(customer.id); const s = overview.summary!;
  s.activeObservations = 126; s.severityCounts = { INFO: 0, LOW: 1, MEDIUM: 123, HIGH: 1, CRITICAL: 1 };
  s.observationPage.truncated = true;
  const requests: URL[] = []; let denied = false;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json:
    denied ? { customerId: customer.id, status: 'ACCESS_DENIED', summary: null } : overview,
  }));
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations?*`, route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (denied) return route.fulfill({ json: { customerId: customer.id, status: 'ACCESS_DENIED', queue: null } });
    const severity = url.searchParams.get('severity') ?? 'ALL'; const status = url.searchParams.get('status') ?? 'ACTIVE';
    const offset = Number((url.searchParams.get('cursor') ?? 'synthetic-0').split('-')[1]);
    let items = Array.from({ length: 126 }, (_, i) => ({ ...s.observationPage.items[0]!, id: `queue-${i}`,
      summary: `Synthetic queue observation ${i}`, severity: i === 0 ? 'CRITICAL' : i === 1 ? 'HIGH' : i === 125 ? 'LOW' : 'MEDIUM',
      priority: i === 0 || i === 1 ? 'URGENT' : 'NORMAL', status: 'OPEN' }));
    if (status === 'RESOLVED' || status === 'SUPPRESSED') items = [{ ...items[2]!, id: 'history-one', summary: 'Synthetic historical observation', status }];
    else if (status === 'ACKNOWLEDGED') items = [];
    items = items.filter(o => severity === 'ALL' || (severity === 'URGENT' ? o.priority === 'URGENT' : o.severity === severity));
    const counts = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const item of items) counts[item.severity as keyof typeof counts]++;
    const total = items.length;
    return route.fulfill({ json: { customerId: customer.id, status: 'READY', queue: {
      mode: 'db', generatedAt: s.generatedAt, retrievedAt: '2026-10-16T16:00:00Z', severity, status, total,
      severityCounts: counts, items: items.slice(offset, offset + 25), devices: s.devices, resources: s.resources,
      nextCursor: offset + 25 < total ? `synthetic-${offset + 25}` : null,
    } } });
  });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await expect(panel.getByText(/Only the first 3 of 126 active observations are loaded/)).toBeVisible();
  expect(requests).toHaveLength(0);
  await panel.getByRole('button', { name: 'Open full observation queue' }).click();
  const queue = panel.getByRole('region', { name: 'Observation queue and history' });
  await expect(queue.getByText('Matching observations across Atlas: 126')).toBeVisible();
  await expect(queue.getByRole('listitem')).toHaveCount(25);
  for (let i = 1; i <= 5; i++) {
    await queue.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(queue.getByText(`Synthetic queue observation ${i * 25}`, { exact: true })).toBeVisible();
  }
  await expect(queue.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await queue.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(queue.getByText('Synthetic queue observation 100', { exact: true })).toBeVisible();
  await queue.getByLabel('Queue severity').selectOption('LOW');
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await expect(queue.getByText('Synthetic queue observation 125', { exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();
  await queue.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(queue.getByRole('listitem')).toHaveCount(25);
  await queue.getByLabel('Queue state').selectOption('RESOLVED');
  await expect(queue.getByText('Synthetic historical observation')).toBeVisible();
  await queue.getByRole('searchbox').fill('missing on this page');
  await expect(queue.getByRole('listitem')).toHaveCount(0);
  expect(requests.at(-1)!.searchParams.get('status')).toBe('RESOLVED');
  denied = true;
  await queue.getByRole('button', { name: 'Refresh queue', exact: true }).click();
  await expect(panel.getByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(panel.getByText('Synthetic historical observation')).toHaveCount(0);
});
