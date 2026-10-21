import { expect, test } from '@playwright/test';
import {
  ateraTicket, customerMessage, failAtera, fitsWidth, linkedAteraCustomer, seriousViolations, settleAction, settled, syncTicket, ticketActions, widths,
  writeAsTechnician,
} from './atera';
import { signIn } from './support';

// M39: the Tickets page, a ticket's panel, the action confirmation, the action log on Connections and the time form's Atera step at
// desktop, tablet and phone widths, in the theme of the project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA
// rules and with the keyboard alone. One reply is sent and its answer lost, so the confirmation that asks what was found, the row
// that says a check is needed and the action's card over its ticket are checked too; every other confirmation is left by its way out.
test('tickets, a ticket panel, the action confirmation, the action log and the Atera step pass axe at every width', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Tx');
  const m = customer.marker;
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${m} VPN-tilkoblingen faller ut hver morgen for hele regnskapsavdelingen` });
  await customerMessage(page, ticket, 'Hei! VPN-en faller ut rundt klokka ni hver dag. Kan dere se på det?');
  await syncTicket(page, ticket, 1);
  await writeAsTechnician(page);
  const name = `#${ticket.TicketID} ${ticket.TicketTitle}`;

  // A reply whose answer is lost: the confirmation's follow-up asks, there and then, what the person found at Atera.
  await failAtera(page, 'POST', `/api/v3/tickets/${ticket.TicketID}/comments`, 503, 1);
  await page.goto('/tickets');
  await page.getByRole('searchbox', { name: 'Search title or number' }).fill(m);
  await page.getByRole('button', { name, exact: true }).click();
  const lostIn = page.getByRole('dialog', { name, exact: true });
  await lostIn.getByRole('textbox', { name: 'Reply', exact: true }).fill('Vi ser på det nå.');
  await lostIn.getByRole('button', { name: 'Send the reply', exact: true }).click();
  const lost = page.getByRole('dialog', { name: `Reply in #${ticket.TicketID}`, exact: true });
  await lost.getByRole('button', { name: 'Send the reply', exact: true }).click();
  await expect(lost.getByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible({ timeout: 30_000 });
  await expect(lost.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await settled(page);
  expect(await seriousViolations(page), `confirmation asking what was found (${scheme})`).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`action-uncertain-confirmation-${scheme}.png`) });
  await page.keyboard.press('Escape');
  await expect(lost).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(lostIn).toHaveCount(0);
  const [uncertain] = await ticketActions(page, ticket, true);
  expect(uncertain?.ticketId).toBeTruthy();

  try {
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto('/tickets');
    await page.getByRole('searchbox', { name: 'Search title or number' }).fill(m);
    const open = page.getByRole('button', { name, exact: true });
    await expect(open).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `tickets at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `tickets scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`tickets-${width}-${scheme}.png`), fullPage: true });
    await expect(open.locator('xpath=ancestor::li[1]').getByText('Check needed', { exact: true })).toBeVisible();

    // The keyboard opens the panel from the title and closes it with Escape, focus back where it was.
    await open.focus(); await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name, exact: true });
    await expect(panel.getByRole('region', { name: 'Conversation', exact: true }).getByRole('listitem')).toHaveCount(1);
    await settled(page);
    expect(await seriousViolations(page), `ticket panel at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`ticket-panel-${width}-${scheme}.png`) });

    // The reply's confirmation names its effects before anything is sent; nothing to type, so the way out has the focus.
    await panel.getByRole('textbox', { name: 'Reply', exact: true }).fill('Vi ser på det i dag.');
    await panel.getByRole('button', { name: 'Send the reply', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: `Reply in #${ticket.TicketID}`, exact: true });
    await expect(confirm.getByText('Atera shows it as written by Dev Admin.', { exact: true })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await settled(page);
    expect(await seriousViolations(page), `action confirmation at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`action-confirmation-${width}-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0); await expect(open).toBeFocused();

    // The notice's address: the action's card over its ticket, with the way to Atera and the verdict; Escape leaves the ticket open.
    await page.goto(`/tickets?ticket=${uncertain!.ticketId}&action=${uncertain!.id}`);
    const card = page.getByRole('dialog', { name: `Reply to the customer · ${name}`, exact: true });
    await expect(card.getByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Check in Atera' })).toBeVisible();
    // It opens on its way out, not on the link that leaves for Atera.
    await expect(card.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await settled(page);
    expect(await seriousViolations(page), `action card over its ticket at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `action card scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`action-card-${width}-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(page).toHaveURL(/\/tickets\?ticket=[0-9a-f-]{36}$/);
    await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible();

    await page.goto('/connections');
    const log = page.getByRole('region', { name: 'Actions at vendors', exact: true });
    await expect(log.getByRole('button', { name: /^All/ })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `connections with the action log at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `connections scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`connections-actions-${width}-${scheme}.png`), fullPage: true });

    // The time form offers the Atera step for a ticket number; once saved, the dialog goes on into its confirmation.
    await page.goto('/time');
    await page.getByRole('button', { name: 'Register hours', exact: true }).first().click();
    const form = page.getByRole('dialog', { name: 'Register hours', exact: true });
    await form.getByRole('combobox', { name: 'Organization' }).pressSequentially(m);
    await page.getByRole('option', { name: customer.name }).click();
    await form.getByRole('textbox', { name: 'Hours' }).fill('0,5');
    await form.getByRole('combobox', { name: 'Work type' }).fill('Remote');
    await form.getByRole('textbox', { name: 'Description' }).fill(`Oppfølging av VPN (${width} px)`);
    await form.getByRole('textbox', { name: 'Ticket' }).fill(String(ticket.TicketID));
    await form.getByRole('checkbox', { name: 'Also record in Atera' }).check();
    await settled(page);
    expect(await seriousViolations(page), `time form with the Atera step at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`time-atera-step-${width}-${scheme}.png`) });
    await form.getByRole('button', { name: 'Register hours', exact: true }).click();
    const record = page.getByRole('dialog', { name: `Record on #${ticket.TicketID} in Atera`, exact: true });
    await expect(record.getByRole('button', { name: 'Record in Atera', exact: true })).toBeEnabled();
    await settled(page);
    expect(await seriousViolations(page), `time recording confirmation at ${width} px (${scheme})`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`time-atera-confirmation-${width}-${scheme}.png`) });
    await record.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(record).toHaveCount(0);
  }
  } finally {
    // The shared database keeps no action waiting for a check (Connections would show it as a gap).
    for (const left of await ticketActions(page, ticket, true)) await settleAction(page, left, 'Failed', 'Accessibility check: nothing was sent.');
  }
});
