import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn } from './support';

// Microsoft Graph is off in the end-to-end stack (no tenant, no consent), which is also what a customer sees before the
// integration is switched on: every Microsoft 365 surface has to say so plainly instead of failing (S10).

test('the Microsoft 365 surfaces explain themselves when Graph is not connected', async ({ page }) => {
  const m = marker('M365');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Microsoft AS`, status: 'Customer' });

  await page.goto(`/organizations/${organization.id}?tab=documents`);
  await expect(page.getByText('SharePoint is not set up for the CRM yet.')).toBeVisible();

  await page.goto(`/organizations/${organization.id}?tab=mail`);
  await expect(page.getByText('Outlook mail is not connected for this sign-in.')).toBeVisible();

  // A meeting is still planned in the CRM; only Outlook is out of reach.
  await api.post(page, '/api/v1/activities/', {
    type: 'Meeting',
    organizationId: organization.id,
    opportunityId: null,
    contractId: null,
    contactId: null,
    subject: `${m} Oppstartsmøte`,
    body: null,
    dueAt: '2027-05-03T09:00:00Z',
    priority: 'Normal',
    assigneeId: null,
    durationMinutes: 45,
    location: 'Teams',
    addToCalendar: false,
  });

  await page.goto(`/organizations/${organization.id}?tab=activities`);
  await expect(page.getByRole('button', { name: 'Read changes from Outlook' })).toBeHidden();
  const row = page.getByRole('listitem').filter({ hasText: `${m} Oppstartsmøte` });
  await expect(row).toBeVisible();
  await expect(row.getByText('In calendar')).toBeHidden();

  // The dialog shows the calendar switch, disabled, with the reason next to it.
  await row.getByRole('button', { name: `Edit ${m} Oppstartsmøte` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('switch', { name: 'Add to my Outlook calendar' })).toBeDisabled();
  await expect(dialog.getByText('Outlook calendar is not connected for this sign-in.')).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: 'Duration' })).toHaveValue('45');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
