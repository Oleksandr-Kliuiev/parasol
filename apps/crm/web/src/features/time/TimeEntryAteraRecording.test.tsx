import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { auxiliary, json } from '../activities/taskTicketTestFixture';
import { entry, renderTimeEntry } from './timeEntryTestFixture';

afterEach(() => vi.unstubAllGlobals());

// M39.3: a new entry on an Atera ticket can also be recorded there, through the one confirmation every vendor action uses.
const KINDS = '/api/v1/actions/kinds?system=atera';
const target = { type: 'time-entry', id: 'entry-new', name: '1.5 h · #4711 Synthetic printer', organizationId: 'customer-one',
  organizationName: 'Synthetic customer', externalCustomerId: '17', url: null };
const preview = {
  previewToken: 'token', expiresAt: null, system: 'atera', kind: 'time.record', level: 'Standard', target,
  effects: [
    { code: 'VND_EFFECT_TIME_RECORD', values: { hours: '1.5', ticket: '#4711', date: '17.10.2026', from: '08:00', to: '09:30' } },
    { code: 'VND_EFFECT_TIME_BILLABLE', values: {} },
    { code: 'VND_EFFECT_TICKET_AUTHOR', values: { name: 'Synthetic technician' } },
    { code: 'VND_EFFECT_TIME_NO_DOUBLE', values: {} },
  ],
  block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
};
const action = {
  id: 'action-one', system: 'atera', kind: 'time.record', level: 'Standard', targetType: 'time-entry', targetId: 'entry-new', targetName: target.name,
  organizationId: 'customer-one', organizationName: 'Synthetic customer', parameters: {}, reason: null, status: 'Succeeded', outcomeCode: 'VND_SENT',
  outcome: 'Sent', reference: 'wh-77', attempts: 1, requestedBy: 'current-technician', requestedByName: 'Synthetic current employee',
  requestedAt: '2026-10-21T10:00:00Z', notBefore: '2026-10-21T10:00:00Z', startedAt: null, completedAt: null, closedBy: null, closedByName: null,
  closedAt: null, closeReason: null, etag: '"1"',
};

const server = (recordable = true) => vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === KINDS) return json(recordable ? [{ system: 'atera', kind: 'time.record', targetType: 'time-entry', level: 'Standard', simulated: false, limitedToCustomers: false }] : []);
  if (url === '/api/v1/time/entries' && init.method === 'POST') return json({ id: 'entry-new' }, 201);
  if (url === '/api/v1/actions/preview') return json(preview);
  if (url === '/api/v1/actions' && init.method === 'POST') return json(action, 202);
  if (url.startsWith('/api/v1/actions?')) return json({ items: [], nextCursor: null, totalCount: 0, uncertain: 0, waiting: 0 });
  return auxiliary(url) ?? json({});
});
const urls = (fetch: ReturnType<typeof server>) => fetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

async function fillNewEntry(ticket: string) {
  await userEvent.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Synthetic customer' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Hours' }), { target: { value: '1,5' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ticket' }), { target: { value: ticket } });
}

it('goes on from the saved entry into the Atera confirmation and sends the command only when confirmed', async () => {
  const fetch = server(); vi.stubGlobal('fetch', fetch); renderTimeEntry(null);
  await fillNewEntry('4711');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Also record in Atera' }));
  expect(screen.getByText('After saving you see what Atera gets, and confirm it.')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));

  const dialog = await screen.findByRole('dialog', { name: 'Record on #4711 in Atera' });
  expect(await within(dialog).findByText('1.5 h are recorded on #4711 in Atera, 17.10.2026 08:00–09:30.')).toBeVisible();
  expect(within(dialog).getByText('The hours are saved in Parasoll. Atera gets them only if you confirm now; do not also add them in Atera by hand, or they are counted twice.')).toBeVisible();
  expect(within(dialog).getByText('Atera marks them billable.')).toBeVisible();
  expect(within(dialog).getByText('The work-hours import recognises them, so they are never counted twice.')).toBeVisible();
  expect(urls(fetch).filter((call) => call.startsWith('POST /api/v1/time/entries'))).toHaveLength(1);
  expect(urls(fetch)).not.toContain('POST /api/v1/actions');

  await userEvent.click(within(dialog).getByRole('button', { name: 'Record in Atera' }));
  expect(await within(dialog).findByText('The vendor accepted the change.')).toBeVisible();
  const command = JSON.parse(fetch.mock.calls.find(([url, init]) => url === '/api/v1/actions' && init?.method === 'POST')![1]!.body as string);
  expect(command).toMatchObject({ system: 'atera', kind: 'time.record', targetType: 'time-entry', targetId: 'entry-new', parameters: {}, previewToken: 'token' });
});

it('keeps the saved entry and closes at once when the person skips Atera', async () => {
  const fetch = server(); vi.stubGlobal('fetch', fetch); renderTimeEntry(null);
  await fillNewEntry('4711');
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Also record in Atera' }));
  await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  const dialog = await screen.findByRole('dialog', { name: 'Record on #4711 in Atera' });
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Skip' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(urls(fetch)).not.toContain('POST /api/v1/actions');
  expect(urls(fetch).filter((call) => call.startsWith('POST /api/v1/time/entries'))).toHaveLength(1);
});

it('saves without offering Atera while Atera takes no recorded hours', async () => {
  const fetch = server(false); vi.stubGlobal('fetch', fetch); renderTimeEntry(null);
  await fillNewEntry('4711');
  await waitFor(() => expect(urls(fetch)).toContain(`GET ${KINDS}`));
  expect(screen.queryByRole('checkbox', { name: 'Also record in Atera' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(urls(fetch)).not.toContain('POST /api/v1/actions/preview');
});

it('asks nothing about Atera for an entry without a ticket number or for an edit', async () => {
  const fetch = server(); vi.stubGlobal('fetch', fetch); renderTimeEntry(null);
  await userEvent.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Synthetic customer' }));
  expect(screen.queryByRole('checkbox', { name: 'Also record in Atera' })).not.toBeInTheDocument();
  expect(urls(fetch)).not.toContain(`GET ${KINDS}`);
});

it('never offers Atera when an existing entry is edited', async () => {
  const fetch = server(); vi.stubGlobal('fetch', fetch); renderTimeEntry(entry);
  await screen.findByRole('button', { name: 'Save' });
  expect(screen.queryByRole('checkbox', { name: 'Also record in Atera' })).not.toBeInTheDocument();
  expect(urls(fetch)).not.toContain(`GET ${KINDS}`);
});
