import { expect, test } from '@playwright/test';
import { ateraAlert, ateraAlertState, linkedAteraCustomer, searchAlerts, storedAlerts, syncAlerts } from './atera';
import { api, signIn } from './support';

// M45: the queue narrows by source and age, and its alerts are chosen one by one, all shown at once or "all that match" the
// filters, then closed in Atera with one confirmation (one vendor action per alert, sent by the worker every 5 s) or hidden in
// Parasoll until a day with one reason, and shown again together.
const SENT = 60_000;

test('old Atera alerts are found by source and age and closed in Atera with one confirmation, each with its outcome', { tag: '@critical' },
  async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, 'Crm.Admin');
    const customer = await linkedAteraCustomer(page, 'Bulk');
    const m = customer.marker;
    const printer = await ateraAlert(page, customer, { Title: `${m} no SNMP response from the printer`, Severity: 'Warning', hoursAgo: 24 * 130 });
    const toner = await ateraAlert(page, customer, { Title: `${m} toner below threshold`, Severity: 'Warning', hoursAgo: 24 * 100 });
    const fresh = await ateraAlert(page, customer, { Title: `${m} disk almost full`, Severity: 'Critical', hoursAgo: 2 });
    await syncAlerts(page, customer, 3);

    await page.goto('/alerts');
    await searchAlerts(page, m);
    await page.getByRole('combobox', { name: 'Source' }).click();
    await page.getByRole('option', { name: 'Atera', exact: true }).click();
    await page.getByRole('combobox', { name: 'Age' }).click();
    await page.getByRole('option', { name: 'Older than 90 days', exact: true }).click();
    await expect(page).toHaveURL(/source=atera/);
    await expect(page).toHaveURL(/olderThan=90/);
    await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('2 alerts: 0 critical, 2 warnings');
    await expect(page.getByRole('button', { name: `${m} disk almost full`, exact: true })).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select all alerts shown' }).check();
    const bar = page.getByRole('region', { name: 'Selected alerts' });
    await expect(bar.getByRole('status')).toHaveText('2 selected');
    await bar.getByRole('button', { name: 'Close in Atera (2)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Close alerts in Atera', exact: true });
    await expect(dialog.getByText('Atera closes these 2 alerts, one by one.', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'To close in Atera (2)' }).getByRole('listitem')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Close 2 in Atera', exact: true }).click();
    await expect(dialog.getByText('All 2 handled.', { exact: true })).toBeVisible({ timeout: SENT });
    const results = dialog.getByRole('list', { name: 'Result for each of the 2 alerts' });
    await expect(results.getByText('Done', { exact: true })).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Closing in Atera is done: all 2 handled.')).toBeVisible();
    // The queue was read again when the batch was done: nothing of the filter is open any longer, so there is nothing to choose.
    await expect(bar).toHaveCount(0);

    // Atera archived both, and the read of each alert after its action resolved it here; the young alert is untouched.
    expect((await ateraAlertState(page, printer))?.Archived).toBe(true);
    expect((await ateraAlertState(page, toner))?.Archived).toBe(true);
    expect((await ateraAlertState(page, fresh))?.Archived).toBeFalsy();
    await expect.poll(async () => (await storedAlerts(page, customer.organizationId)).map((a) => a.title)).toEqual([`${m} disk almost full`]);
    await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveCount(0);

    // Each alert has its own action in the log, under one batch.
    const actions = await api.get<{ items: Array<{ batchId: string | null; status: string }> }>(page,
      `/api/v1/actions?system=atera&targetType=alert&targetId=${printer.AlertID}`);
    expect(actions.items.map((a) => a.status)).toEqual(['Succeeded']);
    const batchId = actions.items[0]!.batchId;
    expect(batchId).toBeTruthy();
    const batch = await api.get<{ total: number; succeeded: number }>(page, `/api/v1/actions/batches/${batchId}`);
    expect([batch.total, batch.succeeded]).toEqual([2, 2]);
  });

test('all alerts that match are hidden until a day with one reason across pages and shown again together', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Hide');
  const m = customer.marker;
  // One more than a page of the queue holds, so "all that match" reaches past the rows shown.
  for (let index = 0; index < 26; index++) {
    await ateraAlert(page, customer, { Title: `${m} OID toner ${String(index).padStart(2, '0')} below threshold`, Severity: 'Warning', hoursAgo: 48 + index });
  }
  await syncAlerts(page, customer, 26);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  await expect(page.getByText('Showing 25 of 26')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all alerts shown' }).check();
  const bar = page.getByRole('region', { name: 'Selected alerts' });
  await expect(bar.getByRole('status')).toHaveText('25 selected');
  await bar.getByRole('button', { name: 'Select all 26 that match the filters' }).click();
  await expect(bar.getByRole('status')).toHaveText('All 26 that match the filters are selected');

  const hideAll = async () => {
    await bar.getByRole('button', { name: 'Hide until… (26)' }).click();
    const hide = page.getByRole('dialog', { name: 'Hide 26 alerts until a date', exact: true });
    await expect(hide.getByText('Parasoll hides 26 alerts until the day you choose', { exact: false })).toBeVisible();
    await hide.getByRole('button', { name: 'In a week', exact: true }).click();
    await hide.getByRole('textbox', { name: /Reason/ }).fill('The toner is ordered for every printer');
    await hide.getByRole('button', { name: 'Hide 26', exact: true }).click();
    await expect(hide).toHaveCount(0);
    await expect(page.locator('[data-alert-list]')).toBeFocused();
    await expect(page.getByText('No alerts match these filters.')).toBeVisible();
    await expect(bar).toHaveCount(0);
  };
  await hideAll();

  // The way back, from the notice above the list: the same 26 are shown again, with no time limit to catch.
  await expect(page.getByText(/^26 alerts hidden until /)).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('26 alerts are shown again.')).toBeVisible();
  await expect(page.getByText('Showing 25 of 26')).toBeVisible();

  // Hidden again, all that match straight from the bar, and shown again from the Hidden list.
  await bar.getByRole('button', { name: 'Select all 26 that match the filters' }).click();
  await expect(bar.getByRole('status')).toHaveText('All 26 that match the filters are selected');
  await hideAll();

  // Under Hidden, each with its day and the one reason; shown again together.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Hidden', exact: true }).click();
  await expect(page).toHaveURL(/[?&]state=hidden/);
  await expect(page.getByText('Showing 25 of 26')).toBeVisible();
  // The oldest first, as in the open list: the first page starts with the alert raised longest ago.
  await page.getByRole('button', { name: `${m} OID toner 25 below threshold`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `${m} OID toner 25 below threshold`, exact: true });
  await expect(panel.getByText(/Hidden until .* by .*: “The toner is ordered for every printer”/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select all alerts shown' }).check();
  await bar.getByRole('button', { name: 'Select all 26 that match the filters' }).click();
  await expect(bar.getByRole('status')).toHaveText('All 26 that match the filters are selected');
  await bar.getByRole('button', { name: 'Show again (26)' }).click();
  const show = page.getByRole('dialog', { name: 'Show 26 alerts again', exact: true });
  await show.getByRole('button', { name: 'Show 26 again', exact: true }).click();
  await expect(show).toHaveCount(0);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Showing 25 of 26')).toBeVisible();
});
