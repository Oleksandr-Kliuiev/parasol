import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { auxiliary, json } from '../activities/taskTicketTestFixture';
import { entry, renderTimeEntry } from './timeEntryTestFixture';

afterEach(() => vi.unstubAllGlobals());
const saves = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => ['PUT', 'POST'].includes((init as RequestInit).method ?? ''));
const fetchOptions = (url: string) => url.startsWith('/api/v1/projects')
  ? json({ items: [{ id: 'project-one', name: 'Synthetic project' }], nextCursor: null, totalCount: 1 }) : auxiliary(url) ?? json({});

it('preserves verified GUIDs and existing author on an unchanged edit with its displayed ETag', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ id: entry.id }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await screen.findByRole('combobox', { name: 'Organization' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Synthetic edited notes' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' })); expect(await screen.findByText('Entry saved')).toBeVisible();
  const [url, init] = saves(fetch)[0]!; expect(url).toBe('/api/v1/time/entries/entry-one'); expect(init.headers).toMatchObject({ 'If-Match': entry.etag });
  expect(JSON.parse(init.body as string)).toMatchObject({ technicianId: entry.technicianId, ticketId: entry.ticketId, sourceActivityId: entry.sourceActivityId,
    externalTicketId: entry.externalTicketId, ticketTitle: entry.ticketTitle, description: 'Synthetic edited notes', projectId: entry.projectId });
});

it.each(['number', 'explicit manual mode'])('clears internal ticket/origin/stale title when choosing %s while preserving manual hours', async mode => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ id: entry.id }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await screen.findByRole('button', { name: 'Use manual ticket number' });
  if (mode === 'number') fireEvent.change(screen.getByRole('textbox', { name: 'Ticket' }), { target: { value: '909' } });
  else await userEvent.click(screen.getByRole('button', { name: 'Use manual ticket number' }));
  expect(screen.queryByRole('button', { name: 'Use manual ticket number' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saves(fetch)).toHaveLength(1));
  expect(JSON.parse(saves(fetch)[0]![1].body as string)).toMatchObject({ ticketId: null, sourceActivityId: null, ticketTitle: null,
    externalTicketId: mode === 'number' ? 909 : 701, hours: entry.hours });
});

it('clears a saved ticket and project when the manual form changes customer', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ id: entry.id }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await userEvent.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Synthetic customer two' })); expect(screen.getByRole('textbox', { name: 'Ticket' })).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saves(fetch)).toHaveLength(1));
  expect(JSON.parse(saves(fetch)[0]![1].body as string)).toMatchObject({ organizationId: 'customer-two', ticketId: null, sourceActivityId: null, ticketTitle: null, externalTicketId: null, projectId: null });
});

it('shows a fieldless validation failure without losing the draft or silently retrying', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ code: 'TIM_TICKET_INVALID' }, 400) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/^The ticket association is invalid/)).toBeVisible(); expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(entry.description);
  expect(screen.getByRole('button', { name: 'Use manual ticket number' })).toBeEnabled(); expect(saves(fetch)).toHaveLength(1);
});

it('preserves field validation and the existing manual registration defaults', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? json({ errors: { Hours: ['Synthetic rejected hours'] } }, 400) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(null); await userEvent.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Synthetic customer' })); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  expect(await screen.findByText('Synthetic rejected hours')).toBeVisible(); expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveValue('1');
  expect(JSON.parse(saves(fetch)[0]![1].body as string)).toMatchObject({ organizationId: 'customer-one', technicianId: null, hours: 1, workDate: '2026-10-17',
    billable: true, onsite: false, afterHours: false, description: null, externalTicketId: null, ticketTitle: null, projectId: null, ticketId: null, sourceActivityId: null });
});

it('replaces an edit draft and ETag when the selected entry changes', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ id: 'entry-two' }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await screen.findByRole('button', { name: 'Save' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Hours' }), { target: { value: '9' } }); fireEvent.click(screen.getByText('Change entry'));
  expect(await screen.findByRole('textbox', { name: 'Hours' })).toHaveValue('2'); expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Synthetic next entry');
  await userEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saves(fetch)).toHaveLength(1));
  expect(saves(fetch)[0]![0]).toBe('/api/v1/time/entries/entry-two'); expect(saves(fetch)[0]![1].headers).toMatchObject({ 'If-Match': '"next-version"' });
});

it.each(['Change employee', 'Drop time'])('aborts scoped work type/project/customer reads after %s and ignores their late data', async change => {
  const held: { signal: AbortSignal; finish: (value: Response) => void; url: string }[] = []; let replacement = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => replacement ? fetchOptions(url) : new Promise<Response>(resolve => held.push({ signal: init.signal!, finish: resolve, url })));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await waitFor(() => expect(held).toHaveLength(3)); replacement = true;
  fireEvent.click(screen.getByText(change)); expect(held.every(read => read.signal.aborted)).toBe(true);
  await act(async () => held.forEach(read => read.finish(read.url.endsWith('work-types') ? json(['Synthetic old work type']) : fetchOptions(read.url))));
  expect(screen.queryByText('Synthetic old work type')).not.toBeInTheDocument();
  if (change === 'Drop time') expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  else expect(await screen.findByRole('textbox', { name: 'Hours' })).toHaveValue(String(entry.hours));
});

it('does not perform any form reads without a time write permission', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); renderTimeEntry(entry, ['time.read']);
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it.each([200, 400])('does not invalidate an active new-owner time query or close its form after a late old update with status %s', async status => {
  let finish!: (value: Response) => void; const probe = vi.fn(async () => 'Synthetic current time cache');
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT'
    ? new Promise<Response>(resolve => { finish = resolve; }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(entry, ['time.own'], probe); await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  await userEvent.click(await screen.findByRole('button', { name: 'Save' })); fireEvent.click(screen.getByText('Change employee'));
  fireEvent.change((await screen.findByRole('textbox', { name: 'Hours' })), { target: { value: '2.5' } });
  await act(async () => finish(json(status === 400 ? { errors: { Hours: ['Synthetic old error'] } } : { id: entry.id }, status)));
  expect(probe).toHaveBeenCalledTimes(1); expect(screen.queryByText('Entry saved')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic old error')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(); expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveValue('2.5');
});

it('takes minutes and clock times, says what it saves, and names what is wrong once a field is left', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? json({ id: entry.id }) : fetchOptions(url));
  vi.stubGlobal('fetch', fetch); renderTimeEntry(); await screen.findByRole('combobox', { name: 'Organization' });
  const hours = screen.getByRole('textbox', { name: 'Hours' });
  await userEvent.clear(hours); await userEvent.type(hours, '45'); await userEvent.tab();
  expect(screen.getByText('At most 24 hours in one entry. For minutes, type 45 min or 0:45.')).toBeVisible();
  expect(hours).toHaveAttribute('aria-invalid', 'true'); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await userEvent.clear(hours); await userEvent.type(hours, '0:45');
  expect(screen.getByText('Saved as 0.75 h')).toBeVisible(); expect(screen.getByRole('button', { name: '45 min', pressed: true })).toBeVisible();
  const ticket = screen.getByRole('textbox', { name: 'Ticket' });
  await userEvent.clear(ticket); await userEvent.type(ticket, 'abc'); await userEvent.tab();
  expect(screen.getByText('Type the ticket number with digits only, like 4711.')).toBeVisible();
  await userEvent.clear(ticket); await userEvent.type(ticket, '909');
  await userEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saves(fetch)).toHaveLength(1));
  expect(JSON.parse(saves(fetch)[0]![1].body as string)).toMatchObject({ hours: 0.75, externalTicketId: 909 });
});
