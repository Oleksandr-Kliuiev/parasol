import { expect, test, type Page } from '@playwright/test';
import type { Activity, ActivityRequest } from '../src/features/activities/types';
import { api, createOrganization, marker, showInMyTasks, signIn } from './support';

type ActivityPage = { items: Activity[]; totalCount: number; nextCursor: string | null };
const selectedUrl = (organizationId: string, activityId: string) => `/organizations/${organizationId}?tab=activities&activityId=${activityId}`;

function edit(activity: Activity, changes: Partial<ActivityRequest> = {}): ActivityRequest {
  return { type: activity.type, organizationId: activity.organizationId, opportunityId: activity.opportunityId,
    contractId: activity.contractId, contactId: activity.contactId, subject: activity.subject, body: activity.body,
    dueAt: activity.dueAt, priority: activity.priority, assigneeId: activity.assignee?.id ?? null,
    durationMinutes: activity.durationMinutes, location: activity.location, addToCalendar: activity.inCalendar, ...changes };
}
async function read(page: Page, organizationId: string, activityId: string) {
  const result = await api.get<ActivityPage>(page, `/api/v1/activities/?organizationId=${organizationId}&activityId=${activityId}`);
  expect(result.items).toHaveLength(1); return result.items[0]!;
}
function preserved(activity: Activity) {
  return { subject: activity.subject, body: activity.body, dueAt: activity.dueAt, assignee: activity.assignee,
    priority: activity.priority, organizationId: activity.organizationId, hasTechnicalSource: activity.hasTechnicalSource };
}

test('status commands use the displayed version and retain another employee’s assignment and exact due instant', { tag: '@critical' }, async ({ page, browser }) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string; permissions: string[] }>(page, '/bff/user');
  expect(employee.permissions).not.toContain('parasol.atlas.read');
  const customer = await createOrganization(page, { name: marker('Versioned status ') });
  const task = await api.post<Activity>(page, '/api/v1/activities/', { type: 'Task', organizationId: customer.id,
    subject: marker('Synthetic status task '), body: 'Synthetic status details', priority: 'Normal',
    assigneeId: employee.id, dueAt: '2050-11-01T09:00:47.123Z', addToCalendar: false });
  const adminContext = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
  try {
    const admin = await adminContext.newPage(); await signIn(admin, 'Crm.Admin');
    const adminUser = await api.get<{ id: string }>(admin, '/bff/user');
    await page.goto(selectedUrl(customer.id, task.id));
    const timeline = page.getByRole('region', { name: 'Activities', exact: true });
    const complete = () => timeline.getByRole('button', { name: `Mark ${task.subject} as done`, exact: true });
    await expect(complete()).toBeVisible();
    const editedResponse = await admin.request.put(`/api/v1/activities/${task.id}`, {
      headers: { 'X-CSRF': '1', 'If-Match': task.etag },
      data: edit(task, { body: 'Synthetic newer details', assigneeId: adminUser.id, priority: 'High', dueAt: '2050-11-02T09:00:47.123Z' }),
    });
    expect(editedResponse.status()).toBe(200); const edited = await editedResponse.json() as Activity;
    expect(edited.etag).not.toBe(task.etag);
    const refused = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/activities/${task.id}/complete`);
    await complete().click(); const failure = await refused;
    expect(failure.status()).toBe(412); expect(failure.request().headers()['if-match']).toBe(task.etag);
    await expect(timeline.getByRole('alert')).toContainText(/refresh|review/i);
    await expect(timeline.getByText(task.body!, { exact: true })).toBeVisible();
    const unchanged = await read(admin, customer.id, task.id);
    expect(unchanged.status).toBe('Open'); expect(unchanged.etag).toBe(edited.etag);
    expect(preserved(unchanged)).toEqual(preserved(edited));
    await timeline.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(timeline.getByText(edited.body!, { exact: true })).toBeVisible();
    const completed = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/activities/${task.id}/complete`);
    await complete().click(); const success = await completed;
    expect(success.status()).toBe(200); expect(success.request().headers()['if-match']).toBe(edited.etag);
    const done = await success.json() as Activity; expect(done.status).toBe('Done');
    expect(done.etag).not.toBe(edited.etag); expect(preserved(done)).toEqual(preserved(edited));
    const reopen = timeline.getByRole('button', { name: `Reopen ${task.subject}`, exact: true });
    await expect(reopen).toBeVisible();
    const changedDoneResponse = await admin.request.put(`/api/v1/activities/${task.id}`, {
      headers: { 'X-CSRF': '1', 'If-Match': done.etag }, data: edit(done, { body: 'Synthetic completed result updated by colleague' }),
    });
    expect(changedDoneResponse.status()).toBe(200); const changedDone = await changedDoneResponse.json() as Activity;
    expect(changedDone.status).toBe('Done'); expect(changedDone.etag).not.toBe(done.etag);
    const refusedReopen = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/activities/${task.id}/reopen`);
    await reopen.click(); const reopenFailure = await refusedReopen;
    expect(reopenFailure.status()).toBe(412); expect(reopenFailure.request().headers()['if-match']).toBe(done.etag);
    await expect(timeline.getByRole('alert')).toContainText(/refresh|review/i);
    await expect(timeline.getByText(edited.body!, { exact: true })).toBeVisible();
    const unchangedDone = await read(admin, customer.id, task.id);
    expect(unchangedDone.status).toBe('Done'); expect(unchangedDone.etag).toBe(changedDone.etag);
    expect(preserved(unchangedDone)).toEqual(preserved(changedDone));
    await timeline.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(timeline.getByText(changedDone.body!, { exact: true })).toBeVisible();
    const reopened = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/activities/${task.id}/reopen`);
    await reopen.click(); const reopenedResponse = await reopened;
    expect(reopenedResponse.status()).toBe(200); expect(reopenedResponse.request().headers()['if-match']).toBe(changedDone.etag);
    const open = await reopenedResponse.json() as Activity; expect(open.status).toBe('Open');
    expect(open.etag).not.toBe(changedDone.etag); expect(preserved(open)).toEqual(preserved(changedDone));
    const missing = await admin.request.post(`/api/v1/activities/${task.id}/complete`, { headers: { 'X-CSRF': '1' } });
    expect(missing.status()).toBe(428); expect((await read(admin, customer.id, task.id)).etag).toBe(open.etag);
    await signIn(page, 'Crm.ReadOnly', selectedUrl(customer.id, task.id));
    await expect(complete()).toHaveCount(0);
    expect((await page.request.post(`/api/v1/activities/${task.id}/reopen`, {
      headers: { 'X-CSRF': '1', 'If-Match': open.etag },
    })).status()).toBe(403);
    expect((await read(admin, customer.id, task.id)).etag).toBe(open.etag);
  } finally { await adminContext.close(); }
});

test('personal task completion admits one pending command and sends its displayed ETag', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const customer = await createOrganization(page, { name: marker('Pending status ') });
  const task = await api.post<Activity>(page, '/api/v1/activities/', { type: 'Task', organizationId: customer.id,
    subject: marker('Synthetic pending command '), body: null, priority: 'High', assigneeId: employee.id,
    dueAt: '2001-11-01T09:00:47.123Z', addToCalendar: false });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const requested = new Promise<void>(resolve => { started = resolve; });
  let settled!: () => void; const finished = new Promise<void>(resolve => { settled = resolve; });
  let requests = 0;
  await page.route(`**/api/v1/activities/${task.id}/complete`, async route => {
    requests++; expect(route.request().headers()['if-match']).toBe(task.etag);
    const response = await route.fetch(); expect(response.status()).toBe(200); started();
    await held;
    try { await route.fulfill({ response }); } finally { settled(); }
  });
  try {
    await page.goto('/'); const personal = page.getByRole('region', { name: 'My tasks', exact: true });
    const complete = personal.getByRole('button', { name: `Mark ${task.subject} as done`, exact: true });
    await showInMyTasks(page, complete); await complete.focus(); await page.keyboard.press('Enter'); await requested;
    await expect(complete).toBeDisabled(); await expect(complete).toBeFocused();
    await page.keyboard.press('Enter'); expect(requests).toBe(1);
    release(); await finished;
    await expect(complete).toHaveCount(0); expect(requests).toBe(1);
    const done = await read(page, customer.id, task.id);
    expect(done.status).toBe('Done'); expect(done.assignee?.id).toBe(employee.id); expect(done.dueAt).toBe(task.dueAt);
  } finally { release(); if (!page.isClosed()) await page.unroute(`**/api/v1/activities/${task.id}/complete`); }
});
