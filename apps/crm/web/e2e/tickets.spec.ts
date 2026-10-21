import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  DEV_TECHNICIAN, ateraTicket, ateraTicketState, customerMessage, failAtera, hoursInAtera, linkedAteraCustomer, syncAtera, syncTicket, writeAsTechnician,
  type AteraTicket,
} from './atera';
import { api, showRow, signIn, toast } from './support';

// M39: the tickets of every customer, read from the Atera stand-in by the real worker jobs, and the changes asked of Atera through
// the one confirmation every vendor action uses. The worker sends an action within seconds (its loop runs every 5 s); the
// stand-in keeps what it got, so each test reads the ticket back from "Atera". The e2e database is shared, so every list is
// narrowed to this test's own marker first.

const SENT = 30_000;

/** Opens the ticket's panel from the Tickets page, narrowed to its title. */
async function openTicket(page: Page, ticket: AteraTicket) {
  await page.goto('/tickets');
  await page.getByRole('searchbox', { name: 'Search title or number' }).fill(ticket.TicketTitle);
  const name = `#${ticket.TicketID} ${ticket.TicketTitle}`;
  await page.getByRole('button', { name, exact: true }).click();
  const panel = page.getByRole('dialog', { name, exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** The confirmation's follow-up: the badge and the outcome the worker reported. */
const followUp = (dialog: Locator) => dialog.getByRole('status');

test('a technician answers a ticket and moves it on from its panel, and Atera gets both as their technician', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Tk');
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${customer.marker} skriveren svarer ikke` });
  await customerMessage(page, ticket, `${customer.marker}: skriveren står fortsatt stille.`);
  await syncTicket(page, ticket, 1);
  await writeAsTechnician(page);

  const panel = await openTicket(page, ticket);
  await expect(panel.getByText(customer.name, { exact: true })).toBeVisible();
  const conversation = panel.getByRole('region', { name: 'Conversation', exact: true });
  await expect(conversation.getByText(`${customer.marker}: skriveren står fortsatt stille.`, { exact: true })).toBeVisible();

  // A reply: what the customer sees and under whose name is said before anything is sent.
  const text = `Vi ser på det nå (${customer.marker}).`;
  await panel.getByRole('textbox', { name: 'Reply', exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Send the reply', exact: true }).click();
  const reply = page.getByRole('dialog', { name: `Reply in #${ticket.TicketID}`, exact: true });
  await expect(reply.getByText('Atera shows it as written by Dev Admin.', { exact: true })).toBeVisible();
  await expect(reply.getByText(text, { exact: true })).toBeVisible();
  await reply.getByRole('button', { name: 'Send the reply', exact: true }).click();
  await expect(followUp(reply)).toContainText('Done', { timeout: SENT });
  await reply.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Reply', exact: true })).toHaveValue('');

  // The status, through the same confirmation; the ticket is read back into the CRM once Atera has it.
  await panel.getByRole('group', { name: 'Change the ticket', exact: true }).getByRole('button', { name: 'Status', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pending', exact: true }).click();
  const status = page.getByRole('dialog', { name: `Set #${ticket.TicketID} to Pending`, exact: true });
  await status.getByRole('button', { name: 'Set to Pending', exact: true }).click();
  await expect(followUp(status)).toContainText('Done', { timeout: SENT });
  await status.getByRole('button', { name: 'Close', exact: true }).click();

  const atera = await ateraTicketState(page, ticket);
  expect(atera.TicketStatus).toBe('Pending');
  expect(atera.Comments.filter((comment) => comment.CommentText === text)).toEqual([
    expect.objectContaining({ IsInternal: false, TechnicianContactID: DEV_TECHNICIAN }),
  ]);
  // The panel lists what was asked of Atera for this ticket, newest first, and shows the conversation with the reply.
  const actions = panel.getByRole('region', { name: 'Actions on this ticket', exact: true });
  await expect(actions.getByRole('listitem')).toHaveCount(2);
  await expect(actions.getByRole('listitem').first()).toContainText('Change status');
  await expect(conversation.getByText(text, { exact: true })).toBeVisible({ timeout: SENT });
});

test('a reply without a clear answer is never sent again and waits in the action log until someone records what they found', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Tu');
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${customer.marker} e-post kommer ikke fram` });
  await syncTicket(page, ticket, 0);
  await writeAsTechnician(page);

  // Atera takes the reply but the answer is lost: the CRM cannot know whether it arrived.
  await failAtera(page, 'POST', `/api/v3/tickets/${ticket.TicketID}/comments`, 503, 1);
  const panel = await openTicket(page, ticket);
  await panel.getByRole('textbox', { name: 'Reply', exact: true }).fill(`Sjekker e-posten (${customer.marker}).`);
  await panel.getByRole('button', { name: 'Send the reply', exact: true }).click();
  const reply = page.getByRole('dialog', { name: `Reply in #${ticket.TicketID}`, exact: true });
  await reply.getByRole('button', { name: 'Send the reply', exact: true }).click();
  await expect(followUp(reply)).toContainText('Check needed', { timeout: SENT });
  await expect(reply.getByText(/^Atera gave no clear answer, so nothing is sent again\. Check in Atera whether it happened/)).toBeVisible();
  await expect(reply.getByRole('link', { name: 'Check in Atera' })).toHaveAttribute('href', new RegExp(`/${ticket.TicketID}$`));
  await reply.getByRole('button', { name: 'Close', exact: true }).click();
  expect((await ateraTicketState(page, ticket)).Comments).toEqual([]);

  // Connections → the action log, narrowed to what needs a check; the verdict is recorded with what was checked.
  await page.goto('/connections');
  const log = page.getByRole('region', { name: 'Actions at vendors', exact: true });
  await log.getByRole('button', { name: /^Check needed/ }).click();
  const title = `Reply to the customer · #${ticket.TicketID} ${ticket.TicketTitle}`;
  const open = await showRow(page, log.getByRole('button', { name: title, exact: true }));
  await open.click();
  const detail = page.getByRole('dialog', { name: title, exact: true });
  await detail.getByRole('radio', { name: 'It did not happen in Atera', exact: true }).check();
  await detail.getByRole('textbox', { name: 'What you checked' }).fill('No reply in the ticket in Atera at 10:05.');
  await detail.getByRole('button', { name: 'Save what you found', exact: true }).click();
  await expect(detail.getByRole('status')).toContainText('Failed');
  await detail.getByRole('button', { name: 'Close', exact: true }).first().click();

  const settled = await api.get<{ items: Array<{ status: string; outcomeCode: string; closeReason: string | null }> }>(page,
    `/api/v1/actions?targetType=ticket&targetId=${ticket.TicketID}`);
  expect(settled.items).toEqual([expect.objectContaining({ status: 'Failed', outcomeCode: 'VND_SETTLED_NOT_DONE', closeReason: 'No reply in the ticket in Atera at 10:05.' })]);
  // Nothing was sent again meanwhile.
  expect((await ateraTicketState(page, ticket)).Comments).toEqual([]);
});

test('own hours are recorded on the ticket in Atera from the time form, and the work-hours import never counts them twice', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Th');
  const ticket = await ateraTicket(page, customer, { TicketTitle: `${customer.marker} ny bærbar` });
  await syncTicket(page, ticket, 0);
  await writeAsTechnician(page);

  await page.goto('/time');
  await page.getByRole('button', { name: 'Register hours', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: 'Register hours', exact: true });
  await form.getByRole('combobox', { name: 'Organization' }).pressSequentially(customer.marker);
  await page.getByRole('option', { name: customer.name }).click();
  await form.getByRole('textbox', { name: 'Hours' }).fill('1,5');
  await form.getByRole('combobox', { name: 'Work type' }).fill('Remote');
  await form.getByRole('textbox', { name: 'Description' }).fill(`Satte opp bærbar (${customer.marker})`);
  await form.getByRole('textbox', { name: 'Ticket' }).fill(String(ticket.TicketID));
  await form.getByRole('checkbox', { name: 'Also record in Atera' }).check();
  await form.getByRole('button', { name: 'Register hours', exact: true }).click();
  await expect(toast(page, 'Hours registered')).toBeVisible();

  // The same dialog goes on into the confirmation of what Atera gets.
  const record = page.getByRole('dialog', { name: `Record on #${ticket.TicketID} in Atera`, exact: true });
  await expect(record.getByText('The hours are saved in Parasoll. Atera gets them only if you confirm now; do not also add them in Atera by hand, or they are counted twice.', { exact: true })).toBeVisible();
  await expect(record.getByText(new RegExp(`^1\\.5 h are recorded on #${ticket.TicketID} in Atera, \\d\\d\\.\\d\\d\\.\\d{4} \\d\\d:\\d\\d–\\d\\d:\\d\\d\\.$`))).toBeVisible();
  // The form takes no start time: the confirmation says where the hours start in Atera.
  await expect(record.getByText('The entry has no start time, so the hours start at 08:00 on its date.', { exact: true })).toBeVisible();
  await expect(record.getByText('The work-hours import recognises them, so they are never counted twice.', { exact: true })).toBeVisible();
  await record.getByRole('button', { name: 'Record in Atera', exact: true }).click();
  await expect(followUp(record)).toContainText('Done', { timeout: SENT });
  await record.getByRole('button', { name: 'Close', exact: true }).click();

  const recorded = (await ateraTicketState(page, ticket)).WorkHours;
  expect(recorded).toEqual([expect.objectContaining({ TechnicianContactID: DEV_TECHNICIAN, TimeSpentInMinutes: 90, Billable: true,
    Description: expect.stringMatching(/\[CRM-TE:[0-9a-f-]{36}\]$/) })]);

  // Someone also records half an hour in Atera itself; the import takes that row and leaves the CRM's own alone.
  await hoursInAtera(page, ticket, { minutes: 30, technician: 4001, comment: `Ringte kunden (${customer.marker})` });
  type Entry = { source: string; hours: number; externalTicketId: number | null };
  const entries = async () => (await api.get<{ items: Entry[] }>(page,
    `/api/v1/time/entries?organizationId=${customer.organizationId}&limit=100`)).items.filter((entry) => entry.externalTicketId === ticket.TicketID);
  await syncAtera(page, ['atera-work-hours'], async () => (await entries()).some((entry) => entry.source === 'Atera'), 'the hours recorded in Atera itself');
  expect((await entries()).map((entry) => `${entry.source} ${entry.hours}`).sort()).toEqual(['Atera 0.5', 'Crm 1.5']);
});
