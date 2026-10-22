import { expect, test } from '@playwright/test';
import { ateraAlert, closeAteraAlert, linkedAteraCustomer, searchAlerts, storedAlerts, syncAlerts, syncAtera } from './atera';
import { api, showInMyTasks, signIn } from './support';

// M38: an alert becomes one task (subject from its title, the employee chooses who and when); a colleague sees that task instead
// of making a second one; the task's Alert button reads the alert again and shows it resolved once Atera closed it.
test('an alert is assigned as one task and the task opens its alert as it is now', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Task');
  const m = customer.marker;
  const atera = await ateraAlert(page, customer, { Title: `${m} disk almost full`, Severity: 'Critical', DeviceName: `SRV-${m}` });
  await syncAlerts(page, customer, 1);
  const me = await api.get<{ displayName: string }>(page, '/bff/user');

  await page.goto('/alerts');
  // The search applies after a short pause: wait for its one result, or a row of the earlier list is focused and then redrawn.
  await searchAlerts(page, m);
  await expect(page.getByRole('status').filter({ hasText: /alerts?:/ })).toHaveText('1 alert: 1 critical, 0 warnings');
  const row = page.getByRole('table', { name: 'Alerts' }).getByRole('row').filter({ hasText: m });
  const assign = row.getByRole('button', { name: `Assign ${m} disk almost full`, exact: true });
  await assign.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assign alert', exact: true });
  const subject = dialog.getByRole('textbox', { name: 'Task subject' });
  await expect(subject).toHaveValue(`${m} disk almost full`);
  await expect(dialog.getByRole('combobox', { name: 'Assignee' })).toHaveValue(me.displayName);
  await expect(dialog.getByText('Priority: High, as the alert is critical.')).toBeVisible();
  await subject.fill(`${m} free disk space on SRV-${m}`);
  await dialog.getByRole('button', { name: 'Tomorrow 16:00', exact: true }).click();
  await expect(dialog.getByText(new RegExp(`^Creates a task for ${me.displayName}, due `))).toBeVisible();
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog.getByText('Task created.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(dialog.getByRole('link', { name: 'Open task', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  // The row names the task in place of Assign, and focus moved to it.
  const taskLink = row.getByRole('link', { name: new RegExp(`^${me.displayName} · due .*: task ${m} free disk space`) });
  await expect(taskLink).toBeVisible(); await expect(taskLink).toBeFocused();

  // The same request again makes no second task.
  const [alert] = await storedAlerts(page, customer.organizationId);
  const preview = await api.get<{ fingerprint: string; task: { id: string } | null; canCreate: boolean }>(page,
    `/api/v1/activities/source-tasks/preview?alertId=${alert!.id}`);
  expect(preview.canCreate).toBe(false);
  const again = await api.post<{ status: string; task: { id: string } }>(page, '/api/v1/activities/source-tasks', {
    alertId: alert!.id, assigneeId: (await api.get<{ id: string }>(page, '/bff/user')).id, dueAt: null, subject: 'Another', expectedFingerprint: preview.fingerprint,
  });
  expect(again).toMatchObject({ status: 'EXISTING', task: { id: preview.task!.id } });

  // A colleague sees the task, not the way to a second one. Signed in first: landing on the alert opens its modal panel, which
  // hides <main> from the accessibility tree that signIn waits for.
  await signIn(page, 'Crm.Technician');
  await page.goto(`/alerts?alert=${alert!.id}`);
  const panel = page.getByRole('dialog', { name: `${m} disk almost full`, exact: true });
  await expect(panel.getByText(`${m} free disk space on SRV-${m}`)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Assign', exact: true })).toHaveCount(0);

  // The task's Alert button reads the alert now, with the time Atera was read: open, then resolved once Atera closed it.
  await signIn(page, 'Crm.Admin');
  const mine = page.getByRole('region', { name: 'My tasks', exact: true }).getByRole('listitem').filter({ hasText: `${m} free disk space` });
  const source = await showInMyTasks(page, mine.getByRole('button', { name: `Alert for ${m} free disk space on SRV-${m}`, exact: true }));
  // Opened from the keyboard: WebKit and Firefox on macOS do not focus a button on a click, so a mouse opening has no place
  // to give focus back to; the keyboard path is the one the return of focus is for.
  await source.focus(); await page.keyboard.press('Enter');
  const sourceDialog = page.getByRole('dialog', { name: 'Alert behind this task', exact: true });
  await expect(sourceDialog.getByText(`${m} disk almost full`)).toBeVisible();
  await expect(sourceDialog.getByText('Open', { exact: true })).toBeVisible();
  // When Atera was last read, apart from when the alert was raised (a read another spec held with a pause says it did not finish).
  await expect(sourceDialog.getByText(/^Atera:? (the )?read at /)).toBeVisible();
  await sourceDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(source).toBeFocused();
  await closeAteraAlert(page, atera);
  await syncAtera(page, ['atera-alerts'], async () => (await storedAlerts(page, customer.organizationId, 'Resolved')).length === 1, 'the resolved alert');
  await source.click();
  await expect(sourceDialog.getByText('Resolved', { exact: true }).first()).toBeVisible();
  await sourceDialog.getByRole('button', { name: 'Close', exact: true }).click();

  // The shared sign-in users collect open tasks from every run: this one is done before the test ends.
  await mine.getByRole('button', { name: `Mark ${m} free disk space on SRV-${m} as done`, exact: true }).click();
  await expect(mine).toHaveCount(0);
});
