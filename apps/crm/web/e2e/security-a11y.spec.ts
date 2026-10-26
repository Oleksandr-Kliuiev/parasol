import { expect, test } from '@playwright/test';
import { ateraAgent, fitsWidth, searchAlerts, seriousViolations, settled, storedMachines, widths } from './atera';
import { huntressAgent, huntressAlerts, huntressEscalation, huntressIncident, linkedHuntressCustomer, syncHuntress } from './huntress';
import { api, signIn } from './support';

// M41: the incident and escalation panels, a machine card with Huntress's protection, the Drift tab's security panel and the coverage
// checks with Huntress's rules at desktop, tablet and phone widths, in the theme of the project (desktop: light, desktop-dark: dark),
// against axe's WCAG 2.2 AA rules, with the keyboard for the panel.
test('the security panels, the machine card and the Drift tab pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Sax');
  const m = customer.marker;
  await ateraAgent(page, customer, { MachineName: `${m}-PC`, OSType: 'Work Station', OS: 'Windows 11 Pro', VendorSerialNumber: `SER-${m}` });
  const agent = await huntressAgent(page, customer, {
    hostname: `${m}-PC`, serial_number: `SER-${m}`, os: 'Windows 11 Pro', defender_status: 'Unhealthy', defender_substatus: 'Signatures out of date',
  });
  await huntressIncident(page, customer, {
    agent_id: agent.id, subject: `LOW - Incident on ${m}-PC with a long subject that has to wrap on a phone`,
    summary: 'A scheduled task starts an unknown program from a temporary folder; Huntress recommends removing it and resetting the password.',
  });
  await huntressEscalation(page, customer, { subject: `${m} login from an unexpected country`, type_code: 'unexpected_country_access' });
  await page.request.post('http://localhost:5299/_mock/huntress/reports', { data: { organization_id: customer.huntressId, incidents_reported: 1 } });
  await syncHuntress(page, ['atera-agents', 'huntress-agents', 'huntress-alerts', 'huntress-organizations', 'huntress-reports'], async () => {
    const overview = await api.get<{ usage: unknown[]; reports: unknown[] }>(page, `/api/v1/security/organizations/${customer.organizationId}/overview`);
    return (await huntressAlerts(page, customer.organizationId)).length === 2 && overview.usage.length === 1 && overview.reports.length === 1
      && (await storedMachines(page, customer.organizationId)).length === 1;
  }, `the security data of ${customer.name}`);
  const [machine] = await storedMachines(page, customer.organizationId);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto('/alerts');
    await searchAlerts(page, m);

    // The incident's panel by keyboard: its plan, comments and machine, then Escape back to the title.
    const title = page.getByRole('button', { name: new RegExp(`^LOW - Incident on ${m}-PC`) });
    await title.focus(); await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: new RegExp(`^LOW - Incident on ${m}-PC`) });
    await expect(panel.getByRole('region', { name: 'Security incident', exact: true }).getByRole('button', { name: 'Approve plan' })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `incident panel at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`incident-panel-${width}-${scheme}.png`), fullPage: true });
    await panel.getByRole('button', { name: 'Send plan back…', exact: true }).click();
    await expect(panel.getByRole('combobox', { name: 'Why' })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `send-back form at ${width} px (${scheme})`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0); await expect(title).toBeFocused();

    const escalation = page.getByRole('button', { name: `${m} login from an unexpected country`, exact: true });
    await escalation.click();
    const notice = page.getByRole('dialog', { name: `${m} login from an unexpected country`, exact: true });
    await expect(notice.getByRole('radio', { name: 'The access was expected' })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `escalation panel at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`escalation-panel-${width}-${scheme}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);

    // The coverage checks with Huntress's rules and their own limits.
    await page.getByRole('button', { name: 'Coverage checks', exact: true }).click();
    const coverage = page.getByRole('dialog', { name: 'Coverage checks', exact: true });
    await expect(coverage.getByRole('region', { name: 'Device without Huntress', exact: true }).getByRole('spinbutton', { name: /Days before an alert/ })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `coverage checks at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `coverage checks scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(coverage).toHaveCount(0);

    // The Drift tab with its security panel, and the machine's card with Huntress's protection.
    await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
    await expect(page.getByRole('region', { name: 'Security', exact: true }).getByText('Agents billed')).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `Drift tab at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `Drift tab scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`drift-security-${width}-${scheme}.png`), fullPage: true });

    await page.goto(`/organizations/${customer.organizationId}?tab=drift&device=${machine!.id}`);
    const card = page.getByRole('dialog', { name: `${m}-PC`, exact: true });
    await expect(card.getByText(/^Defender: Unhealthy · Signatures out of date/)).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `machine card at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`machine-protection-${width}-${scheme}.png`), fullPage: true });
  }
});
