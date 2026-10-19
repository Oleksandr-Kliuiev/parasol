import { expect, test, type Page } from '@playwright/test';
import type { Activity } from '../src/features/activities/types';
import { assertTaskEvidence, control, employee, fixture, json, staffContext, taskPath, taskPreview, workspace, type Operation } from './support';

async function taskList(page: Page, customerId = fixture().target.customerId) {
  return await json(await page.request.get(`/api/v1/activities/?organizationId=${customerId}&type=Task&limit=200`), 'Generic CRM Task count') as { items: Activity[]; totalCount: number };
}

test('revoking either the real technician membership or token clears its card while the independent administrator still works', async ({ browser }) => {
  const f = fixture(); const admin = await staffContext(browser, 'Crm.Admin');
  const transitions: [Operation, Operation][] = [['revokeTechnicianMembership', 'restoreTechnicianMembership'], ['revokeTechnicianToken', 'restoreTechnicianToken']];
  try {
    for (const [revoke, restore] of transitions) {
      const technician = await staffContext(browser, 'Crm.Technician', `/organizations/${f.target.customerId}`);
      try {
        const panel = technician.page.getByRole('region', { name: 'Technical workspace · Atlas' });
        await expect(panel.getByText(f.target.criticalSummary, { exact: true })).toBeVisible();
        const preview = await taskPreview(technician.page, f.target.criticalObservationId);
        expect(preview.status).toBe('READY'); expect(preview.canCreate).toBe(true);
        const before = (await taskList(admin.page)).totalCount; expect(before).toBe(1);
        control(revoke);
        await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(panel.getByText('Your Atlas access does not permit reading this customer.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('tab')).toHaveCount(0);
        await expect(panel.getByText(f.target.criticalSummary, { exact: true })).toHaveCount(0);
        await expect(panel.getByText(f.target.duplicateHostname, { exact: true })).toHaveCount(0);
        const denied = await taskPreview(technician.page, f.target.criticalObservationId);
        expect(denied.status).toBe('ACCESS_DENIED'); expect(denied.observation).toBeNull(); expect(denied.sha256).toBeNull();
        const attempted = await json(await technician.page.request.post(`${taskPath(f.target.customerId, f.target.criticalObservationId)}/task`, {
          headers: { 'X-CSRF': '1' }, data: { assigneeId: employee('Crm.Technician').id, dueAt: null, expectedSha256: preview.sha256 },
        }), 'Creation is denied after actual Atlas revocation', 409) as { code: string };
        expect(attempted.code).toBe('PARASOL_TASK_SOURCE_UNAVAILABLE');
        expect((await taskList(admin.page)).totalCount, 'A denied handoff never adds a SQL Task').toBe(before);
        expect((await workspace(admin.page, f.target.customerId)).status, 'Administrator uses its own independent Atlas authority').toBe('READY');
        assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
      } finally { control(restore); await technician.context.close(); }
    }
  } finally { await admin.context.close(); }
});

test('ordinary Finance and ReadOnly roles cannot turn generic CRM work into Atlas authority or new source work', async ({ browser }) => {
  const f = fixture(); const admin = await staffContext(browser, 'Crm.Admin');
  const finance = await staffContext(browser, 'Crm.Finance', `/organizations/${f.target.customerId}?tab=activities`);
  const reader = await staffContext(browser, 'Crm.ReadOnly', `/organizations/${f.target.customerId}`);
  try {
    const tasks = await taskList(finance.page); expect(tasks.totalCount).toBe(1);
    const task = tasks.items[0]!;
    expect(task.subject).toBe('Review technical observation'); expect(task.body).toBeNull(); expect(task.hasTechnicalSource).toBe(true);
    expect(JSON.stringify(task).includes(f.target.observationSummaryOutsideFirst100), 'Finance sees no copied personal Atlas source').toBe(false);
    expect((await finance.page.request.get(`/api/v1/parasol/activities/${task.id}/atlas-observation`)).status(), 'Finance technical source role gate').toBe(403);
    const timeline = finance.page.getByRole('region', { name: 'Activities', exact: true });
    await expect(timeline.getByText('Review technical observation', { exact: true })).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'View Atlas source', exact: true })).toHaveCount(0);
    const preview = await taskPreview(admin.page, f.target.criticalObservationId); expect(preview.status).toBe('READY');
    const input = { assigneeId: employee('Crm.Technician').id, dueAt: null, expectedSha256: preview.sha256 };
    expect((await reader.page.request.post(`${taskPath(f.target.customerId, f.target.criticalObservationId)}/task`, {
      headers: { 'X-CSRF': '1' }, data: input,
    })).status(), 'ReadOnly source assignment role gate').toBe(403);
    await expect(reader.page.getByRole('button', { name: 'Assign work', exact: true })).toHaveCount(0);
    const financeId = (await json(await finance.page.request.get('/bff/user'), 'Actual Finance identity')) as { id: string };
    const invalidAssignee = await json(await admin.page.request.post(`${taskPath(f.target.customerId, f.target.criticalObservationId)}/task`, {
      headers: { 'X-CSRF': '1' }, data: { ...input, assigneeId: financeId.id },
    }), 'A nontechnical employee cannot be assigned personal technical work', 400) as { code: string };
    expect(invalidAssignee.code).toBe('ACT_SOURCE_TASK_ASSIGNEE_INVALID');
    expect((await taskList(admin.page)).totalCount).toBe(1); assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
  } finally { await reader.context.close(); await finance.context.close(); await admin.context.close(); }
});

async function identity(page: Page, customerId: string) {
  return await json(await page.request.get(`/api/v1/parasol/customers/${customerId}/identity`), 'Current synthetic customer mapping') as {
    linkId: string | null; atlas: { workspaceId: string; clientId: string } | null;
  };
}

async function unlink(page: Page, linkId: string) {
  expect((await page.request.delete(`/api/v1/integrations/links/${linkId}`, { headers: { 'X-CSRF': '1' } })).status(), 'Explicit mapping unlink').toBe(204);
}

async function map(page: Page, customerId: string, atlasClientId: string, workspaceId: string, name: string) {
  const input = { snapshot: { schemaVersion: 1, source: 'atlas', workspaceId, clients: [{ clientId: atlasClientId, name }] },
    mappings: [{ atlasClientId, customerId }] };
  const preview = await json(await page.request.post('/api/v1/parasol/customer-identities/import?dryRun=true', {
    headers: { 'X-CSRF': '1' }, data: input,
  }), 'Real mapping dry run') as { sha256: string; canApply: boolean };
  expect(preview.canApply).toBe(true); expect(/^[a-f0-9]{64}$/.test(preview.sha256)).toBe(true);
  const applied = await json(await page.request.post(`/api/v1/parasol/customer-identities/import?dryRun=false&expectedSha256=${preview.sha256}`, {
    headers: { 'X-CSRF': '1' }, data: input,
  }), 'Explicit real mapping confirmation') as { canApply: boolean };
  expect(applied.canApply).toBe(true);
}

test('foreign workspace collisions fail closed and replacing a same-pair mapping invalidates old source confirmation and pagination', async ({ browser }) => {
  const f = fixture(); const admin = await staffContext(browser, 'Crm.Admin'); const collision = f.clients.at(-1)!;
  let collisionUnlinked = false; let targetUnlinked = false;
  try {
    const original = await identity(admin.page, collision.crmCustomerId); expect(original.linkId !== null).toBe(true);
    await unlink(admin.page, original.linkId!); collisionUnlinked = true;
    await map(admin.page, collision.crmCustomerId, collision.atlasClientId, f.collisionWorkspaceId, collision.name);
    const foreign = await workspace(admin.page, collision.crmCustomerId); expect(foreign.status).toBe('ACCESS_DENIED'); expect(foreign.summary).toBeNull();
    await admin.page.goto(`/organizations/${collision.crmCustomerId}`);
    const panel = admin.page.getByRole('region', { name: 'Technical workspace · Atlas' });
    await expect(panel.getByText('Your Atlas access does not permit reading this customer.', { exact: true })).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(0);
    const foreignLink = await identity(admin.page, collision.crmCustomerId); await unlink(admin.page, foreignLink.linkId!);
    await map(admin.page, collision.crmCustomerId, collision.atlasClientId, f.workspaceId, collision.name); collisionUnlinked = false;
    expect((await workspace(admin.page, collision.crmCustomerId)).status).toBe('READY');
    const review = await taskPreview(admin.page, f.target.criticalObservationId); expect(review.status).toBe('READY');
    const firstQueue = await json(await admin.page.request.get(`/api/v1/parasol/customers/${f.target.customerId}/observations?severity=ALL&status=ACTIVE`), 'Real protected queue continuation') as {
      status: string; queue: { nextCursor: string | null };
    };
    expect(firstQueue.status).toBe('READY'); expect(firstQueue.queue.nextCursor !== null).toBe(true);
    const targetIdentity = await identity(admin.page, f.target.customerId); await unlink(admin.page, targetIdentity.linkId!); targetUnlinked = true;
    await map(admin.page, f.target.customerId, f.target.atlasClientId, f.workspaceId, f.clients[0]!.name); targetUnlinked = false;
    const oldPage = await json(await admin.page.request.get(`/api/v1/parasol/customers/${f.target.customerId}/observations?severity=ALL&status=ACTIVE&cursor=${encodeURIComponent(firstQueue.queue.nextCursor!)}`), 'Old same-pair cursor fails after LinkId replacement') as { status: string; queue: null };
    expect(oldPage.status).toBe('IDENTITY_CHANGED'); expect(oldPage.queue).toBeNull();
    const stale = await json(await admin.page.request.post(`${taskPath(f.target.customerId, f.target.criticalObservationId)}/task`, {
      headers: { 'X-CSRF': '1' }, data: { assigneeId: employee('Crm.Technician').id, dueAt: null, expectedSha256: review.sha256 },
    }), 'Old review cannot assign a new Task after LinkId replacement', 409) as { code: string };
    expect(stale.code).toBe('PARASOL_TASK_SOURCE_CHANGED'); expect((await taskList(admin.page)).totalCount).toBe(1);
    assertTaskEvidence(control('countsTaskEvidence'), 1, 2);
  } finally {
    if (targetUnlinked) await map(admin.page, f.target.customerId, f.target.atlasClientId, f.workspaceId, f.clients[0]!.name);
    if (collisionUnlinked) {
      const current = await identity(admin.page, collision.crmCustomerId); if (current.linkId) await unlink(admin.page, current.linkId);
      await map(admin.page, collision.crmCustomerId, collision.atlasClientId, f.workspaceId, collision.name);
    }
    await admin.context.close();
  }
});
