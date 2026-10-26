import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { todayIso } from '../../shared/utils/format';
import { TimesheetPage } from './TimesheetPage';
import { entry as base } from './timeEntryTestFixture';
import type { TimeEntry } from './types';

afterEach(() => vi.unstubAllGlobals());

// M39: hours saved in Parasoll without Atera are recorded there later from the row's menu of My timesheet; what Atera has of the
// week's entries is read in one lookup.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const today = todayIso();
const row = (id: string, changes: Partial<TimeEntry>): TimeEntry => ({
  ...base, id, technicianId: 'u1', workDate: today, ticketId: null, sourceActivityId: null, ticketTitle: null, ...changes,
});
const waiting = row('entry-waiting', { externalTicketId: 4711, hours: 1.5, description: 'Not in Atera yet' });
const recorded = row('entry-recorded', { externalTicketId: 4712, hours: 2, description: 'Already in Atera', status: 'Approved' });
const unclear = row('entry-unclear', { externalTicketId: 4713, hours: 0.5, description: 'Unclear recording' });
const noTicket = row('entry-no-ticket', { externalTicketId: null, hours: 1, description: 'No ticket' });
const fromAtera = row('entry-atera', { source: 'Atera', externalTicketId: 4714, hours: 0.25, description: 'Came from Atera' });
const uncertainAction = {
  id: 'action-unclear', system: 'atera', kind: 'time.record', level: 'Standard', targetType: 'time-entry', targetId: unclear.id, targetName: '0.5 h · #4713',
  organizationId: 'customer-one', organizationName: 'Synthetic customer', parameters: { ticket: 4713 }, reason: null, status: 'Uncertain',
  outcomeCode: 'VND_NO_ANSWER', outcome: 'No answer.', reference: null, attempts: 5, requestedBy: 'u1', requestedByName: 'Kari Nordmann',
  requestedAt: '2026-10-21T10:00:00Z', notBefore: '2026-10-21T10:00:00Z', startedAt: null, completedAt: '2026-10-21T10:30:00Z', closedBy: null,
  closedByName: null, closedAt: null, closeReason: null, ticketId: 'ticket-4713', vendorUrl: 'https://atera.example/ticket/4713', etag: '"1"',
};

const server = () => vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url.startsWith('/api/v1/time/entries?')) return json({
    items: [waiting, recorded, unclear, noTicket, fromAtera], nextCursor: null, totalCount: 5, periodClosed: false,
    summary: { hours: 5.25, billableHours: 5.25, approvedHours: 2, newHours: 3.25 },
  });
  if (url === '/api/v1/actions/lookup') return json({ items: [
    { targetId: recorded.id, waiting: 0, done: 1, uncertain: 0, checkId: null },
    { targetId: unclear.id, waiting: 0, done: 0, uncertain: 1, checkId: uncertainAction.id },
  ] });
  if (url === '/api/v1/actions/kinds?system=atera') return json([{ system: 'atera', kind: 'time.record', targetType: 'time-entry', level: 'Standard', simulated: false, limitedToCustomers: false }]);
  if (url === '/api/v1/actions/preview' && init.method === 'POST') return json({
    previewToken: 'token', expiresAt: null, system: 'atera', kind: 'time.record', level: 'Standard',
    target: { type: 'time-entry', id: waiting.id, name: '1.5 h · #4711', organizationId: 'customer-one', organizationName: 'Synthetic customer', externalCustomerId: '17', url: null },
    effects: [{ code: 'VND_EFFECT_TIME_NO_DOUBLE', values: {} }], block: null,
    confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
  });
  if (url === `/api/v1/actions/${uncertainAction.id}`) return json(uncertainAction);
  return json({ items: [], nextCursor: null, totalCount: 0 });
});

const itemOf = (description: string) => screen.getByText(description).closest('li')!;

it('records hours saved without Atera later from the row menu, and marks what Atera already has', async () => {
  const fetch = server(); vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<TimesheetPage />)], '/', testUser(['time.own', 'service.read']));
  await screen.findByText('Not in Atera yet');
  // One lookup for the week's own entries on a ticket: neither the entry without a ticket nor the one from Atera.
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/actions/lookup')).toHaveLength(1));
  const lookup = JSON.parse(fetch.mock.calls.find(([url]) => url === '/api/v1/actions/lookup')![1]!.body as string);
  expect(lookup).toEqual({ system: 'atera', targetType: 'time-entry', targetIds: [waiting.id, recorded.id, unclear.id] });

  expect(await within(itemOf('Already in Atera')).findByText('In Atera')).toBeVisible();
  expect(within(itemOf('Already in Atera')).queryByRole('button', { name: /^More for/ })).not.toBeInTheDocument();
  expect(within(itemOf('No ticket')).queryByRole('button', { name: /^More for/ })).not.toBeInTheDocument();
  expect(within(itemOf('Came from Atera')).queryByRole('button', { name: /^More for/ })).not.toBeInTheDocument();

  await userEvent.click(await within(itemOf('Not in Atera yet')).findByRole('button', { name: /^More for 1\.5 h for Synthetic customer/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Record in Atera' }));
  const dialog = await screen.findByRole('dialog', { name: 'Record on #4711 in Atera' });
  expect(within(dialog).getByText('Atera gets these hours only when you confirm; do not also add them in Atera by hand, or they are counted twice.')).toBeVisible();
  const preview = JSON.parse(fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')![1]!.body as string);
  expect(preview).toEqual({ system: 'atera', kind: 'time.record', targetType: 'time-entry', targetId: waiting.id, parameters: {} });
});

it('opens the card of a recording without a clear answer from its row, to check it in Atera', async () => {
  vi.stubGlobal('fetch', server());
  renderRoutes([page(<TimesheetPage />)], '/', testUser(['time.own', 'service.read']));
  const unclearRow = itemOf(await screen.findByText('Unclear recording').then((node) => node.textContent!));
  expect(await within(unclearRow).findByText('Check needed')).toBeVisible();
  await userEvent.click(within(unclearRow).getByRole('button', { name: /^More for 0\.5 h for Synthetic customer/ }));
  expect(screen.queryByRole('menuitem', { name: 'Record in Atera' })).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Check the recording in Atera' }));
  const card = await screen.findByRole('dialog', { name: 'Record time in Atera · 0.5 h · #4713' });
  expect(within(card).getByRole('link', { name: 'Check in Atera' })).toHaveAttribute('href', 'https://atera.example/ticket/4713');
  expect(within(card).getByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible();
});
