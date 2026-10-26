import { expect, test, type Page } from '@playwright/test';
import { ateraTicket, customerMessage, linkedAteraCustomer, searchAlerts } from './atera';
import { huntressAlerts, huntressIncident, linkedHuntressCustomer } from './huntress';
import { api, signIn } from './support';
import type { ConnectionStatusView } from '../src/features/integrations/connectionStatusContract';

// M44: a vendor's webhook brings a change into Parasoll within a minute. The stand-in sends what Huntress (signed the way Svix signs) or an
// Atera automation rule would send to crm-web, and the worker's early-read loop starts the read: these tests never start a job
// themselves, and the schedules of the e2e suite never run. Other specs start the same reads by hand in parallel workers, so a change
// may also arrive with one of theirs; the early-read loop itself is proven by the SQL tests (EarlyReadRunnerTests).
const webhooks = 'http://localhost:5299/_mock/webhooks';
const EARLY = 60_000;

async function webhook(page: Page, system: 'huntress' | 'atera', body: unknown) {
  const response = await page.request.post(`${webhooks}/${system}`, { data: body });
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { status: number }).status, `crm-web's answer to the ${system} webhook`).toBe(204);
}

/** What /connections says of a system's webhook now. */
async function webhookState(page: Page, system: string) {
  const view = await api.get<ConnectionStatusView>(page, '/api/v1/integrations/connections');
  return view.integrations.find((integration) => integration.system === system)!.webhook!;
}

test('a Huntress incident reaches the alert queue within a minute of its webhook, and Connections names the event', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Hook');
  const subject = `LOW - Incident on ${customer.marker}-PC`;
  const incident = await huntressIncident(page, customer, { subject, summary: `${customer.marker}: synthetic incident` });
  const before = await webhookState(page, 'huntress');
  expect(before.enabled).toBe(true);

  await webhook(page, 'huntress', {
    event_type: 'incident_report.created', id: incident.id, organization: { id: customer.huntressId, name: customer.name }, subject,
  });

  const after = await webhookState(page, 'huntress');
  expect(after.received).toBe(before.received + 1);
  expect(after.lastEventType).toBe('incident_report.created');
  await expect.poll(async () => (await huntressAlerts(page, customer.organizationId)).map((alert) => alert.title), { timeout: EARLY, intervals: [1_000] })
    .toEqual([subject]);
  await page.goto('/alerts');
  await searchAlerts(page, customer.marker);
  await expect(page.getByRole('button', { name: subject, exact: true })).toBeVisible();

  await page.goto('/connections');
  const row = page.getByRole('region', { name: 'Huntress', exact: true }).getByRole('listitem').filter({ hasText: 'Webhook' });
  await expect(row.getByText('On', { exact: true })).toBeVisible();
  await expect(row).toContainText(/Last event .+: new security incident/);
});

test('an Atera ticket a webhook names comes with its conversation, without a manual read', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'HookT');
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${customer.marker} printer is down` });
  await customerMessage(page, ticket, `${customer.marker}: the printer shows an error`);
  const before = await webhookState(page, 'atera');

  await webhook(page, 'atera', { TicketID: ticket.TicketID });

  expect((await webhookState(page, 'atera')).received).toBe(before.received + 1);
  await expect.poll(async () => {
    const found = await api.get<{ items: Array<{ id: string; externalId: number }> }>(page,
      `/api/v1/service/tickets?search=${encodeURIComponent(ticket.TicketTitle)}&limit=5`);
    const id = found.items.find((item) => item.externalId === ticket.TicketID)?.id;
    return id ? (await api.get<{ totalCount: number }>(page, `/api/v1/service/tickets/${id}/comments?limit=1`)).totalCount : 0;
  }, { timeout: EARLY, intervals: [1_000] }).toBeGreaterThanOrEqual(1);
});

test('a delivery that cannot prove its sender is refused, and an unsigned one does not mark the webhook broken', async ({ page }) => {
  await signIn(page, 'Crm.Admin');
  const before = await webhookState(page, 'huntress');
  // Not through the stand-in: no signature at all, as a stranger would post it.
  const response = await page.request.post('/webhooks/huntress', { data: { event_type: 'incident_report.created', id: 1 } });
  expect(response.status()).toBe(401);
  expect(await response.text()).not.toContain('incident_report');
  expect((await page.request.post('/webhooks/cloudally', { data: {} })).status()).toBe(404);
  const after = await webhookState(page, 'huntress');
  expect([after.lastRefusedAt, after.received]).toEqual([before.lastRefusedAt, before.received]);
});
