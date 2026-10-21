import { expect, test, type Page } from '@playwright/test';
import type { Activity, ActivityRequest } from '../src/features/activities/types';
import { api, createOrganization, marker, showInMyTasks, signIn } from './support';

type ActivityPage = { items: Activity[]; totalCount: number; nextCursor: string | null };
const selectedUrl = (organizationId: string, activityId: string) => `/organizations/${organizationId}?tab=activities&activityId=${activityId}`;
const invalidText = 'This activity link is invalid. Choose all customer activities to continue.';
const missingText = 'This activity was not found for this customer. It may have been removed or moved.';

function requestFor(activity: Activity, subject = activity.subject): ActivityRequest {
  return { type: activity.type, organizationId: activity.organizationId, opportunityId: activity.opportunityId,
    contractId: activity.contractId, contactId: activity.contactId, subject, body: activity.body, dueAt: activity.dueAt,
    priority: activity.priority, assigneeId: activity.assignee?.id ?? null, durationMinutes: activity.durationMinutes,
    location: activity.location, addToCalendar: activity.inCalendar };
}

async function createTask(page: Page, organizationId: string, subject: string, body: string, assigneeId: string, dueAt = '2050-11-01T09:00:47.123Z') {
  return api.post<Activity>(page, '/api/v1/activities/', { type: 'Task', organizationId, subject, body,
    priority: 'Normal', assigneeId, dueAt, addToCalendar: false });
}

async function exactRead(page: Page, organizationId: string, activityId: string) {
  return api.get<ActivityPage>(page, `/api/v1/activities/?organizationId=${organizationId}&activityId=${activityId}&limit=1`);
}

function activityRequests(page: Page) {
  const reads: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/v1/activities/') reads.push(url);
  });
  return reads;
}

test('a personal task beyond the first fifty opens exactly and preserves edit concurrency without Atlas', { tag: '@critical' }, async ({ page, browser }) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string; permissions: string[] }>(page, '/bff/user');
  expect(employee.permissions).toContain('activities.write'); expect(employee.permissions).not.toContain('parasol.atlas.read');
  const adminContext = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
  try {
    const admin = await adminContext.newPage(); await signIn(admin, 'Crm.Admin');
    const adminUser = await api.get<{ id: string }>(admin, '/bff/user');
    const customer = await createOrganization(page, { name: marker('Exact task customer ') });
    const subject = marker('Repeated synthetic task ');
    const target = await createTask(page, customer.id, subject, 'Synthetic exact target details', employee.id);
    for (let offset = 0; offset < 60; offset += 4) {
      await Promise.all(Array.from({ length: 4 }, () => createTask(page, customer.id, subject,
        'Synthetic other task details', adminUser.id, '2050-10-01T09:00:00Z')));
    }
    const ordinary = await api.get<ActivityPage>(page, `/api/v1/activities/?organizationId=${customer.id}`);
    expect(ordinary.totalCount).toBe(61); expect(ordinary.items).toHaveLength(50);
    expect(ordinary.items.every(item => item.subject === subject)).toBe(true);
    expect(ordinary.items.some(item => item.id === target.id)).toBe(false); expect(ordinary.nextCursor).not.toBeNull();
    const reads = activityRequests(page);
    await page.goto('/');
    const link = await showInMyTasks(page, page.getByRole('region', { name: 'My tasks', exact: true })
      .getByRole('link', { name: `${subject} · Open activity for ${customer.name}`, exact: true }));
    await expect(link).toHaveAttribute('href', selectedUrl(customer.id, target.id)); reads.length = 0;
    await link.focus(); await page.keyboard.press('Enter');
    const timeline = page.getByRole('region', { name: 'Activities', exact: true });
    await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
    await expect(timeline.getByRole('listitem')).toHaveCount(1);
    await expect(timeline.getByText(target.body!, { exact: true })).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'View Atlas source', exact: true })).toHaveCount(0);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.searchParams.get('activityId')).toBe(target.id);
    expect(reads[0]!.searchParams.get('organizationId')).toBe(customer.id);
    expect(reads[0]!.searchParams.has('cursor')).toBe(false);

    const original = (await exactRead(page, customer.id, target.id)).items[0]!;
    await timeline.getByRole('button', { name: `Edit ${subject}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit activity', exact: true });
    const draft = marker('Synthetic local draft '); await dialog.getByRole('textbox', { name: 'Subject', exact: true }).fill(draft);
    const concurrentSubject = marker('Synthetic concurrent change ');
    const concurrent = await admin.request.put(`/api/v1/activities/${target.id}`, {
      headers: { 'X-CSRF': '1', 'If-Match': original.etag }, data: requestFor(original, concurrentSubject),
    });
    expect(concurrent.status()).toBe(200);
    const current = await concurrent.json() as Activity; expect(current.etag).not.toBe(original.etag);
    const refused = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/v1/activities/${target.id}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await refused; expect(response.status()).toBe(412);
    expect(response.request().headers()['if-match']).toBe(original.etag);
    await expect(dialog.getByText(/Your draft has been kept\. Close and reopen/)).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue(draft);
    const afterRefusal = (await exactRead(page, customer.id, target.id)).items[0]!;
    expect(afterRefusal.subject).toBe(concurrentSubject); expect(afterRefusal.etag).toBe(current.etag);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const refresh = timeline.getByRole('button', { name: 'Refresh activity', exact: true });
    await refresh.focus(); await page.keyboard.press('Enter');
    await expect(timeline.getByText(concurrentSubject, { exact: true })).toBeVisible();
    await expect(refresh).toBeFocused();
    await timeline.getByRole('button', { name: `Edit ${concurrentSubject}`, exact: true }).click();
    const reviewedSubject = marker('Synthetic reviewed change ');
    await dialog.getByRole('textbox', { name: 'Subject', exact: true }).fill(reviewedSubject);
    const saved = page.waitForResponse(result => result.request().method() === 'PUT' && new URL(result.url()).pathname === `/api/v1/activities/${target.id}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const savedResponse = await saved; expect(savedResponse.status()).toBe(200);
    expect(savedResponse.request().headers()['if-match']).toBe(current.etag);
    await expect(dialog).toHaveCount(0); await expect(timeline.getByText(reviewedSubject, { exact: true })).toBeVisible();
    const updated = (await exactRead(page, customer.id, target.id)).items[0]!;
    expect(updated.id).toBe(target.id); expect(updated.dueAt).toBe(target.dueAt); expect(updated.body).toBe(target.body);
    await page.reload();
    await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
    await expect(timeline.getByText(reviewedSubject, { exact: true })).toBeVisible();
    await timeline.getByRole('button', { name: 'All customer activities', exact: true }).click();
    await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toHaveCount(0);
    await expect(timeline.getByRole('listitem')).toHaveCount(50);
    expect(new URL(page.url()).searchParams.has('activityId')).toBe(false);
  } finally { await adminContext.close(); }
});

test('unavailable or invalid activity links never open another record and read-only access cannot edit', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const first = await createOrganization(page, { name: marker('Selected first ') });
  const second = await createOrganization(page, { name: marker('Selected second ') });
  const target = await createTask(page, first.id, marker('Private synthetic task '), 'Synthetic old editor details', employee.id);
  const other = await createTask(page, second.id, marker('Other synthetic task '), 'Synthetic other customer details', employee.id);
  await page.goto(selectedUrl(first.id, target.id));
  const timeline = page.getByRole('region', { name: 'Activities', exact: true });
  await expect(timeline.getByText(target.body!, { exact: true })).toBeVisible();
  await timeline.getByRole('button', { name: `Edit ${target.subject}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit activity', exact: true })).toBeVisible();
  const reads = activityRequests(page);
  await page.goto(selectedUrl(second.id, target.id));
  await expect(timeline.getByText(missingText, { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit activity', exact: true })).toHaveCount(0);
  await expect(timeline.getByRole('listitem')).toHaveCount(0);
  await expect(timeline.getByText(other.subject, { exact: true })).toHaveCount(0);
  expect(reads.every(url => url.searchParams.get('activityId') === target.id)).toBe(true);
  for (const value of ['not-a-guid', '', `${target.id}&activityId=${other.id}`]) {
    reads.length = 0; await page.goto(`/organizations/${second.id}?tab=activities&activityId=${value}`);
    await expect(timeline.getByText(invalidText, { exact: true })).toBeVisible();
    await expect(timeline.getByRole('listitem')).toHaveCount(0); expect(reads).toHaveLength(0);
  }
  const removed = await page.request.delete(`/api/v1/activities/${other.id}`, { headers: { 'X-CSRF': '1' } });
  expect(removed.status()).toBe(204); await page.goto(selectedUrl(second.id, other.id));
  await expect(timeline.getByText(missingText, { exact: true })).toBeVisible();
  await expect(timeline.getByRole('listitem')).toHaveCount(0);
  await signIn(page, 'Crm.ReadOnly', selectedUrl(first.id, target.id));
  await expect(timeline.getByText(target.body!, { exact: true })).toBeVisible();
  await expect(timeline.getByRole('button', { name: `Edit ${target.subject}`, exact: true })).toHaveCount(0);
  await expect(timeline.getByRole('button', { name: `Mark ${target.subject} as done`, exact: true })).toHaveCount(0);
  expect((await page.request.put(`/api/v1/activities/${target.id}`, { headers: { 'X-CSRF': '1', 'If-Match': target.etag }, data: requestFor(target) })).status()).toBe(403);
});

test('Back discards a delayed real selected read without restoring an old task or editor', { tag: '@critical' }, async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const customer = await createOrganization(page, { name: marker('Delayed selected ') });
  const target = await createTask(page, customer.id, marker('Delayed task '), 'Synthetic delayed exact details', employee.id);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const requested = new Promise<void>(resolve => { started = resolve; });
  let finished!: () => void; const settled = new Promise<void>(resolve => { finished = resolve; });
  let realRows: Activity[] = [];
  let networkFailureObserved = false;
  page.on('requestfailed', request => {
    if (new URL(request.url()).searchParams.get('activityId') === target.id) networkFailureObserved = true;
  });
  await page.route('**/api/v1/activities/?*', async route => {
    if (new URL(route.request().url()).searchParams.get('activityId') !== target.id) return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    realRows = (await response.json() as ActivityPage).items; started(); await held;
    try { await route.fulfill({ response }); }
    finally { finished(); }
  });
  try {
    await page.goto('/'); const tasks = page.getByRole('region', { name: 'My tasks', exact: true });
    // Observe the platform AbortSignal without changing the delegated fetch or its response.
    await page.evaluate(activityId => {
      const observed = window as typeof window & { __activityReadProbe?: { started: number; aborted: number; signalPresent: boolean; originalFetch: typeof window.fetch } };
      const originalFetch = window.fetch; const probe = { started: 0, aborted: 0, signalPresent: false, originalFetch };
      observed.__activityReadProbe = probe;
      window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.pathname === '/api/v1/activities/' && url.searchParams.get('activityId') === activityId) {
          probe.started++;
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          probe.signalPresent = signal !== null && signal !== undefined;
          if (signal?.aborted) probe.aborted++;
          else signal?.addEventListener('abort', () => { probe.aborted++; }, { once: true });
        }
        return originalFetch.call(window, input, init);
      };
    }, target.id);
    await test.step('open and hold one real selected HTTP response', async () => {
      await (await showInMyTasks(page, tasks.getByRole('link', { name: `${target.subject} · Open activity for ${customer.name}`, exact: true }))).click();
      await requested;
      expect(realRows.map(row => row.id)).toEqual([target.id]);
      expect(await page.evaluate(() => {
        const probe = (window as typeof window & { __activityReadProbe?: { started: number; aborted: number; signalPresent: boolean } }).__activityReadProbe;
        return probe && { started: probe.started, aborted: probe.aborted, signalPresent: probe.signalPresent };
      })).toEqual({ started: 1, aborted: 0, signalPresent: true });
    });
    await test.step('return through browser history while the response is held', async () => {
      await page.goBack(); await expect(tasks).toBeVisible();
    });
    await test.step('observe the real client cancellation before releasing data', async () => {
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __activityReadProbe?: { aborted: number } }).__activityReadProbe?.aborted)).toBe(1);
    });
    const failedBeforeRelease = networkFailureObserved;
    await test.step('release and settle the held real response after cancellation', async () => { release(); await settled; });
    await expect(page.getByRole('region', { name: 'Activities', exact: true })).toHaveCount(0);
    await expect(page.getByText(target.body!, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Edit activity', exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    const starts = await page.evaluate(() => (window as typeof window & { __activityReadProbe?: { started: number } }).__activityReadProbe?.started);
    expect(starts).toBe(1);
    await testInfo.attach('selected-read-cancellation', { contentType: 'application/json', body: JSON.stringify({
      clientAbortCount: 1, fetchStarts: starts, networkFailureBeforeRelease: failedBeforeRelease, networkFailureAfterRelease: networkFailureObserved,
    }) });
  } finally {
    release();
    if (!page.isClosed()) {
      await page.unroute('**/api/v1/activities/?*');
      await page.evaluate(() => {
        const observed = window as typeof window & { __activityReadProbe?: { originalFetch: typeof window.fetch } };
        if (observed.__activityReadProbe) window.fetch = observed.__activityReadProbe.originalFetch;
        delete observed.__activityReadProbe;
      });
    }
  }
});
