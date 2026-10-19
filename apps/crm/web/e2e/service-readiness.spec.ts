import { expect, test } from '@playwright/test';
import { api, createContact, createOrganization, marker, signIn } from './support';

const readError = 'Saved data could not be read. No previous data is shown. Try again or refresh saved data.';
const loading = 'Loading saved data';
function resource(url: URL, organizationId: string) {
  if (url.pathname === `/api/v1/service/organizations/${organizationId}/summary`) return 'summary';
  if (url.searchParams.get('organizationId') !== organizationId) return null;
  return ({ '/api/v1/service/tickets': 'tickets', '/api/v1/service/devices': 'devices',
    '/api/v1/service/alerts': 'alerts', '/api/v1/service/ticket-requests': 'requests' } as Record<string, string>)[url.pathname] ?? null;
}

test('saved Service data distinguishes unknown summary and a failed list, retries independently and refreshes by GET only', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const customer = await createOrganization(page, { name: marker('Saved service ') });
  const reads: Record<string, number> = { summary: 0, tickets: 0, devices: 0, alerts: 0, requests: 0 };
  let writes = 0; let firstSummary = true; let failTickets = true; let started = false;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const pending = new Promise<void>(resolve => { requested = resolve; });
  let settled!: () => void; const finished = new Promise<void>(resolve => { settled = resolve; });
  page.on('request', request => {
    const url = new URL(request.url()); const kind = resource(url, customer.id);
    if (kind && request.method() === 'GET') reads[kind] = reads[kind]! + 1;
    if (url.pathname.startsWith('/api/v1/service/') && request.method() !== 'GET') writes++;
  });
  await page.route('**/api/v1/service/**', async route => {
    const kind = resource(new URL(route.request().url()), customer.id);
    if (kind === 'tickets' && failTickets) return route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503, title: 'Synthetic read unavailable' }) });
    if (kind !== 'summary' || !firstSummary) return route.continue();
    firstSummary = false;
    const response = await route.fetch(); expect(response.status()).toBe(200); started = true; requested();
    await held;
    try { await route.fulfill({ response }); } finally { settled(); }
  });
  try {
    await page.goto(`/organizations/${customer.id}?tab=service`); await pending;
    const summary = page.getByRole('region', { name: 'Saved service summary', exact: true });
    const tickets = page.getByRole('region', { name: 'Tickets', exact: true });
    await expect(summary.getByText(loading, { exact: true })).toBeVisible();
    await expect(summary.getByText('0', { exact: true })).toHaveCount(0);
    await expect(tickets.getByText(readError, { exact: true })).toBeVisible();
    await expect(tickets.getByText('No open tickets.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Devices', exact: true }).getByText('No devices from Atera yet.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Open alerts', exact: true }).getByText('No open critical alerts or warnings.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ticket requests', exact: true }).getByText('No saved ticket requests need attention.', { exact: true })).toBeVisible();
    release(); await finished;
    await expect(summary.getByText('0', { exact: true })).toHaveCount(4);
    await expect(page.getByText('Last saved ticket change is unknown.', { exact: true })).toBeVisible();
    failTickets = false; await tickets.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(tickets.getByText('No open tickets.', { exact: true })).toBeVisible();
    expect(reads).toEqual({ summary: 1, tickets: 2, devices: 1, alerts: 1, requests: 1 });
    const responses = Promise.all(Object.keys(reads).map(kind => page.waitForResponse(response =>
      response.request().method() === 'GET' && resource(new URL(response.url()), customer.id) === kind)));
    const refresh = page.getByRole('button', { name: 'Refresh saved data', exact: true });
    await refresh.focus(); await page.keyboard.press('Enter');
    for (const response of await responses) {
      expect(response.status()).toBe(200); expect(new URL(response.url()).searchParams.has('cursor')).toBe(false);
    }
    await expect(refresh).toBeEnabled(); await expect(refresh).toBeFocused();
    expect(reads).toEqual({ summary: 2, tickets: 3, devices: 2, alerts: 2, requests: 2 }); expect(writes).toBe(0);
  } finally { release(); if (started) await finished; if (!page.isClosed()) await page.unroute('**/api/v1/service/**'); }
});

test('leaving Service cancels a held real request list and cannot restore the previous customer’s ticket request', { tag: '@critical' }, async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Sales');
  const customer = await createOrganization(page, { name: marker('Cancelled service ') });
  const contact = await createContact(page, customer.id, { firstName: 'Synthetic', lastName: 'Contact', email: 'service-test@example.invalid' });
  const title = marker('Synthetic pending service request ');
  const created = await api.post<{ id: string }>(page, '/api/v1/service/ticket-requests', {
    organizationId: customer.id, contactId: contact.contactId, title, description: 'Synthetic local request only', priority: 'Low', type: 'Incident',
  });
  await page.addInitScript(organizationId => {
    const observed = window as typeof window & { __serviceReadProbe?: { starts: number; aborted: number; original: typeof window.fetch } };
    const original = window.fetch; const probe = { starts: 0, aborted: 0, original }; observed.__serviceReadProbe = probe;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === '/api/v1/service/ticket-requests' && url.searchParams.get('organizationId') === organizationId) {
        probe.starts++; const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        if (signal?.aborted) probe.aborted++; else signal?.addEventListener('abort', () => { probe.aborted++; }, { once: true });
      }
      return original.call(window, input, init);
    };
  }, customer.id);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const pending = new Promise<void>(resolve => { requested = resolve; });
  let settled!: () => void; const finished = new Promise<void>(resolve => { settled = resolve; });
  let started = false;
  const pattern = '**/api/v1/service/ticket-requests?*';
  await page.route(pattern, async route => {
    if (new URL(route.request().url()).searchParams.get('organizationId') !== customer.id) return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    const actual = await response.json() as { items: Array<{ id: string }> };
    expect(actual.items.some(item => item.id === created.id)).toBe(true); started = true; requested(); await held;
    try { await route.fulfill({ response }); } finally { settled(); }
  });
  try {
    await test.step('hold the customer’s real durable request list', async () => {
      await page.goto(`/organizations/${customer.id}?tab=service`); await pending;
      await expect(page.getByRole('region', { name: 'Ticket requests', exact: true }).getByText(loading, { exact: true })).toBeVisible();
    });
    await test.step('leave through the application while the read is held', async () => {
      await page.getByRole('main').getByRole('link', { name: 'Organizations', exact: true }).click();
      await expect(page).toHaveURL(/\/organizations$/);
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __serviceReadProbe?: { aborted: number } }).__serviceReadProbe?.aborted)).toBe(1);
    });
    await test.step('release the real response without restoring old customer data', async () => {
      release(); await finished;
      await expect(page.getByRole('region', { name: 'Saved service data', exact: true })).toHaveCount(0);
      await expect(page.getByText(title, { exact: false })).toHaveCount(0);
      const probe = await page.evaluate(() => {
        const state = (window as typeof window & { __serviceReadProbe?: { starts: number; aborted: number } }).__serviceReadProbe;
        return { starts: state?.starts, aborted: state?.aborted };
      });
      expect(probe).toEqual({ starts: 1, aborted: 1 });
      await testInfo.attach('service-read-cancellation', { body: JSON.stringify(probe), contentType: 'application/json' });
    });
  } finally {
    release(); if (started) await finished;
    if (!page.isClosed()) {
      await page.unroute(pattern);
      await page.evaluate(() => {
        const observed = window as typeof window & { __serviceReadProbe?: { original: typeof window.fetch } };
        if (observed.__serviceReadProbe) window.fetch = observed.__serviceReadProbe.original;
      });
    }
  }
});
