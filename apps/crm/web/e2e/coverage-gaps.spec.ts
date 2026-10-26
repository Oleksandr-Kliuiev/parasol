import { expect, test, type Page } from '@playwright/test';
import { ateraAgent, changeAteraAgent, linkedAteraCustomer, searchAlerts, storedAlerts, syncAtera, type AteraCustomer } from './atera';
import { signIn } from './support';

// M40: after each complete read of Atera's agents Parasoll checks whether every device is still watched. An agent silent past the
// limit (7 days) is an alert of Parasoll itself, worded in the reader's language; once the agent reports again, the checks after
// the next reads no longer find it and the second of them closes it. Every read checks every linked customer, so the test waits
// for the outcome rather than counting reads (other tests read Atera's agents at the same time). It never changes the limit: the
// setting is the whole CRM's, and the browsers run this test side by side.
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const gapsOf = async (page: Page, customer: AteraCustomer) =>
  (await storedAlerts(page, customer.organizationId)).filter((alert) => alert.title.startsWith(`The Atera agent on ${customer.marker}-SRV `));

test('a silent Atera agent is a coverage gap of Parasoll until it reports again', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Gap');
  const m = customer.marker;
  const agent = await ateraAgent(page, customer, { MachineName: `${m}-SRV`, OSType: 'Server', OS: 'Windows Server 2022', Online: false, LastSeen: daysAgo(12) });
  await syncAtera(page, ['atera-agents'], async () => (await gapsOf(page, customer)).length === 1, `a coverage gap of ${customer.name}`);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  const title = page.getByRole('button', { name: new RegExp(`^The Atera agent on ${m}-SRV has not reported since \\d{2}/\\d{2}/\\d{4}$`) });
  await expect(title).toBeVisible();
  const row = page.getByRole('row').filter({ has: title });
  await expect(row).toContainText('Critical');
  await expect(row).toContainText('Source: Parasoll');

  // Its panel says Parasoll found it and how it closes; there is no source to act at, only hiding it in Parasoll.
  await title.click();
  const panel = page.getByRole('dialog', { name: new RegExp(`^The Atera agent on ${m}-SRV`) });
  await expect(panel.getByText('Found by Parasoll’s own check. It closes by itself once two checks in a row no longer find it.')).toBeVisible();
  await expect(panel.getByRole('region', { name: 'In Parasoll', exact: true }).getByRole('button', { name: 'Hide until…', exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'In Atera', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // The settings are there for a person to see; this test leaves them as they are.
  await page.getByRole('button', { name: 'Coverage checks', exact: true }).click();
  const checks = page.getByRole('dialog', { name: 'Coverage checks', exact: true });
  const silent = checks.getByRole('region', { name: 'Silent Atera agent', exact: true });
  await expect(silent.getByRole('switch', { name: 'Raise alerts' })).toBeChecked();
  const days = silent.getByRole('spinbutton', { name: /Days without contact/ });
  await days.fill('0');
  await checks.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(silent.getByText('Enter a whole number from 1 to 90.')).toBeVisible();
  await checks.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(checks).toHaveCount(0);

  // The agent reports again: the gap closes after the checks of the next reads no longer find it.
  await changeAteraAgent(page, agent.AgentID, { Online: true, LastSeen: new Date().toISOString() });
  await syncAtera(page, ['atera-agents'], async () => (await gapsOf(page, customer)).length === 0, `the closed gap of ${customer.name}`);
  await page.reload();
  await searchAlerts(page, m);
  await expect(page.getByText('No alerts match these filters.')).toBeVisible();
  await expect(title).toHaveCount(0);
});
