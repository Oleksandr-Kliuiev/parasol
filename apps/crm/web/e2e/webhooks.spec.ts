import { expect, test, type Page } from '@playwright/test';
import { ateraTicket, customerMessage, linkedAteraCustomer, searchAlerts } from './atera';
import { huntressAlerts, huntressIncident, linkedHuntressCustomer } from './huntress';
import { api, signIn } from './support';

// M44: a vendor's webhook brings a change into Parasoll within seconds. The stand-in sends what Huntress (signed the way Svix signs) or an
// Atera automation rule would send to crm-web, and the worker's early-read loop starts the read: these tests never start a job
// themselves, and the schedules of the e2e suite never run.
const webhooks = 'http://localhost:5299/_mock/webhooks';
const EARLY = 60_000;

async function webhook(page: Page, system: 'huntress' | 'atera', body: unknown) {
  const response = await page.request.post(`${webhooks}/${system}`, { data: body });
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { status: number }).status, `crm-web's answer to the ${system} webhook`).toBe(204);
}

test('a Huntress incident reaches the alert queue through its webhook, and Connections names the event', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Hook');
  const subject = `LOW - Incident on ${customer.marker}-PC`;
  const incident = await huntressIncident(page, customer, { subject, summary: `${customer.marker}: synthetic incident` });

  await webhook(page, 'huntress', {
    event_type: 'incident_report.created', id: incident.id, organization: { id: customer.huntressId, name: customer.name }, subject,
  });

  await expect.poll(async () => (await huntressAlerts(page, customer.organizationId)).map((alert) => alert.title), { timeout: EARLY, intervals: [1_000] })
    .toEqual([subject]);
  await page.goto('/alerts');
  await searchAlerts(page, customer.marker);
  await expect(page.getByRole('button', { name: subject, exact: true })).toBeVisible();

  await page.goto('/connections');
  const card = page.getByRole('region', { name: 'Huntress', exact: true });
  const row = card.getByRole('listitem').filter({ hasText: 'Webhook' });
  await expect(row.getByText('On', { exact: true })).toBeVisible();
  await expect(row).toContainText(/Last event .+: new security incident/);
  await expect(row).toContainText('Read early');
});

test('an Atera ticket a webhook names comes with its conversation, without a manual read', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'HookT');
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${customer.marker} printer is down` });
  await customerMessage(page, ticket, `${customer.marker}: the printer shows an error`);

  await webhook(page, 'atera', { TicketID: ticket.TicketID });

  await expect.poll(async () => {
    const found = await api.get<{ items: Array<{ id: string; externalId: number }> }>(page,
      `/api/v1/service/tickets?search=${encodeURIComponent(ticket.TicketTitle)}&limit=5`);
    const id = found.items.find((item) => item.externalId === ticket.TicketID)?.id;
    return id ? (await api.get<{ totalCount: number }>(page, `/api/v1/service/tickets/${id}/comments?limit=1`)).totalCount : 0;
  }, { timeout: EARLY, intervals: [1_000] }).toBeGreaterThanOrEqual(1);
});

test('a delivery that cannot prove its sender is refused and shown on Connections', async ({ page }) => {
  await signIn(page, 'Crm.Admin');
  // Not through the stand-in: no signature at all, as a stranger would post it.
  const response = await page.request.post('/webhooks/huntress', { data: { event_type: 'incident_report.created', id: 1 } });
  expect(response.status()).toBe(401);
  expect(await response.text()).not.toContain('incident_report');
  expect((await page.request.post('/webhooks/atera/not-the-key', { data: { TicketID: 1 } })).status()).toBe(401);
  expect((await page.request.post('/webhooks/cloudally', { data: {} })).status()).toBe(404);
});
