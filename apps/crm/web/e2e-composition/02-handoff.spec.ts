import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Activity } from '../src/features/activities/types';
import { parseTaskOutcome } from '../src/features/parasol/observationTaskContract';
import { assertTaskEvidence, control, employee, fixture, json, openTargetAssignment, staffContext, taskPath, taskPreview } from './support';

async function confirmAssignment(page: Page, dialog: Locator, localDue: string) {
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Task subject: Review technical observation', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Task priority: Normal', { exact: true })).toBeVisible();
  const picker = dialog.getByRole('combobox'); await picker.fill(employee('Crm.Technician').displayName); await picker.press('ArrowDown');
  await page.getByRole('option').filter({ hasText: employee('Crm.Technician').displayName }).click();
  await dialog.getByLabel('Due date (optional)', { exact: true }).fill(localDue);
  await dialog.getByRole('checkbox', { name: 'I confirm the assignee and due date', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeEnabled();
}

function assertDueAt(actual: string | null | undefined, expected: string) {
  expect(typeof actual, 'The persisted due date remains present').toBe('string');
  const instant = Date.parse(actual ?? '');
  expect(Number.isFinite(instant), 'The persisted due date is a valid timestamp').toBe(true);
  expect(instant, 'The persisted due date preserves the reviewed instant').toBe(Date.parse(expected));
}

test('two genuine employee handoffs converge on one private Task, which personal Tasks completes and replay preserves', async ({ browser }) => {
  const f = fixture(); assertTaskEvidence(control('countsTaskEvidence'), 0);
  const admin = await staffContext(browser, 'Crm.Admin');
  const secondWriter = await staffContext(browser, 'Crm.Technician');
  const technician = await staffContext(browser, 'Crm.Technician');
  try {
    await technician.page.goto('/');
    const myTasks = technician.page.getByRole('region', { name: 'My tasks', exact: true });
    const refreshTasks = myTasks.getByRole('button', { name: 'Refresh my tasks', exact: true });
    await expect(refreshTasks).toBeEnabled();
    await expect(myTasks.getByText('Nothing assigned to you right now.', { exact: true })).toBeVisible();
    const adminDialog = await openTargetAssignment(admin.page);
    const secondDialog = await openTargetAssignment(secondWriter.page);
    const due = '2030-11-01T10:00';
    const expectedDue = await admin.page.evaluate(local => new Date(local).toISOString(), due);
    await confirmAssignment(admin.page, adminDialog, due); await confirmAssignment(secondWriter.page, secondDialog, due);
    const route = taskPath(f.target.customerId, f.target.observationIdOutsideFirst100);
    const responseFor = (page: Page) => page.waitForResponse(r => r.url() === new URL(`${route}/task`, f.baseUrl).href && r.request().method() === 'POST');
    const adminResponse = responseFor(admin.page); const secondResponse = responseFor(secondWriter.page);
    await Promise.all([
      adminDialog.getByRole('button', { name: 'Create task', exact: true }).click(),
      secondDialog.getByRole('button', { name: 'Create task', exact: true }).click(),
    ]);
    const [first, second] = await Promise.all([adminResponse, secondResponse]);
    expect(first.status(), 'First real UI assignment result').toBe(200); expect(second.status(), 'Second real UI assignment result').toBe(200);
    const outcomes = [parseTaskOutcome(await first.json(), f.target.customerId), parseTaskOutcome(await second.json(), f.target.customerId)];
    expect(outcomes.map(o => o.status).sort().join(','), 'Concurrent UI handoffs adopt one durable receipt').toBe('CREATED,EXISTING');
    expect(outcomes[0]!.task?.activityId).toBe(outcomes[1]!.task?.activityId);
    const taskId = outcomes[0]!.task!.activityId;
    for (const result of outcomes) {
      expect(result.task?.status).toBe('Open'); expect(result.task?.assigneeId).toBe(employee('Crm.Technician').id);
      assertDueAt(result.task?.dueAt, expectedDue);
    }
    assertTaskEvidence(control('countsTaskEvidence'), 1);
    const list = await json(await admin.page.request.get(`/api/v1/activities/?organizationId=${f.target.customerId}&type=Task&limit=200`), 'Real generic CRM Task list') as { items: Activity[]; totalCount: number };
    expect(list.totalCount).toBe(1); expect(list.items.length).toBe(1);
    const task = list.items[0]!;
    expect(task.id).toBe(taskId); expect(task.subject).toBe('Review technical observation'); expect(task.body).toBeNull();
    expect(task.priority).toBe('Normal'); expect(task.hasTechnicalSource).toBe(true); expect(task.assignee?.id).toBe(employee('Crm.Technician').id);
    const forbidden = [f.workspaceId, f.target.atlasClientId, f.target.observationIdOutsideFirst100,
      f.target.observationSummaryOutsideFirst100, f.target.duplicateHostname, 'rawPayload', 'evidenceRefs'];
    expect(forbidden.some(text => JSON.stringify(task).includes(text)), 'The broad CRM Task contains no technical source payload or identity').toBe(false);
    const audit = await json(await admin.page.request.get(`/api/v1/audit/?module=activities&entityType=Activity&entityId=${taskId}&limit=200`), 'Real Task audit read');
    expect(forbidden.some(text => JSON.stringify(audit).includes(text)), 'The broad audit contains no copied source details').toBe(false);
    const openTask = adminDialog.getByRole('link', { name: 'Open task', exact: true });
    await expect(openTask).toHaveAttribute('href', `/organizations/${f.target.customerId}?tab=activities&activityId=${taskId}`);
    await openTask.click();
    const timeline = admin.page.getByRole('region', { name: 'Activities', exact: true });
    const timelineTask = timeline.getByRole('listitem').filter({ hasText: 'Review technical observation' });
    await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
    await expect(timelineTask).toHaveCount(1);
    await timelineTask.getByRole('button', { name: 'View Atlas source', exact: true }).click();
    const source = admin.page.getByRole('dialog', { name: 'View Atlas source', exact: true });
    await expect(source.getByText(f.target.observationSummaryOutsideFirst100, { exact: true })).toBeVisible();
    await expect(source.getByRole('button', { name: 'Create task', exact: true })).toHaveCount(0);
    await source.getByRole('button', { name: 'Close', exact: true }).click();
    const personalTask = myTasks.getByRole('listitem').filter({ hasText: 'Review technical observation' });
    await expect(personalTask, 'The already-open recipient has not silently refreshed').toHaveCount(0);
    await refreshTasks.focus();
    const received = technician.page.waitForResponse(r => {
      const url = new URL(r.url());
      return r.request().method() === 'GET' && url.pathname === '/api/v1/activities/' && url.searchParams.get('mine') === 'true'
        && url.searchParams.get('open') === 'true' && !url.searchParams.has('cursor');
    });
    await technician.page.keyboard.press('Enter');
    const receivedResponse = await received;
    expect(receivedResponse.status(), 'Explicit recipient refresh starts from page one').toBe(200);
    const receivedTask = ((await receivedResponse.json()) as { items: Activity[] }).items.find(item => item.id === taskId);
    expect(receivedTask?.etag, 'The recipient received a version for its Task').toBeTruthy();
    await expect(personalTask).toHaveCount(1);
    await expect(refreshTasks).toBeFocused();
    await personalTask.getByRole('button', { name: 'View Atlas source', exact: true }).click();
    const personalSource = technician.page.getByRole('dialog', { name: 'View Atlas source', exact: true });
    await expect(personalSource.getByText(f.target.observationSummaryOutsideFirst100, { exact: true })).toBeVisible();
    await personalSource.getByRole('button', { name: 'Close', exact: true }).click();
    const completed = technician.page.waitForResponse(r => r.url().endsWith(`/api/v1/activities/${taskId}/complete`) && r.request().method() === 'POST');
    await personalTask.getByRole('button', { name: 'Mark Review technical observation as done', exact: true }).click();
    const completedResponse = await completed;
    expect(completedResponse.status(), 'Ordinary personal Task completion').toBe(200);
    expect(completedResponse.request().headers()['if-match'], 'Completion carries the recipient’s displayed version').toBe(receivedTask!.etag);
    await expect(myTasks.getByText('Review technical observation', { exact: true })).toHaveCount(0);
    assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
    const existingDialog = await openTargetAssignment(admin.page);
    await expect(existingDialog.getByText('Task state: Done', { exact: true })).toBeVisible();
    await expect(existingDialog.getByRole('button', { name: 'Create task', exact: true })).toHaveCount(0);
    const preview = await taskPreview(admin.page); expect(preview.status).toBe('READY'); expect(preview.canCreate).toBe(false);
    expect(preview.task?.activityId).toBe(taskId); expect(preview.task?.status).toBe('Done');
    assertDueAt(preview.task?.dueAt, expectedDue);
    // An explicit replay with different requested assignment/due must return the original completed Task unchanged.
    const replay = parseTaskOutcome(await json(await admin.page.request.post(`${route}/task`, {
      headers: { 'X-CSRF': '1' }, data: { assigneeId: employee('Crm.Admin').id, dueAt: null, expectedSha256: preview.sha256 },
    }), 'Real idempotent Task replay'), f.target.customerId);
    expect(replay.status).toBe('EXISTING'); expect(replay.task?.activityId).toBe(taskId); expect(replay.task?.status).toBe('Done');
    expect(replay.task?.assigneeId).toBe(employee('Crm.Technician').id); assertDueAt(replay.task?.dueAt, expectedDue);
    assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
  } finally { await technician.context.close(); await secondWriter.context.close(); await admin.context.close(); }
});
