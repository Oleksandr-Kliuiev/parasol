import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { allowed, association, auxiliary, json, otherTicket, pageOf, renderTaskTicket, task, ticket } from './taskTicketTestFixture';

afterEach(() => vi.unstubAllGlobals());
const open = async () => userEvent.click(await screen.findByRole('button', { name: `Service ticket for ${task.subject}` }));
const writes = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit).method === 'PUT');
const readCount = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url, init]) => (url as string).includes('/ticket?') && (init as RequestInit).method === 'GET').length;

it('reads only on demand and never presents loading/error as no association', async () => {
  let finish!: (value: Response) => void; const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); expect(fetch).not.toHaveBeenCalled(); await open();
  expect(await screen.findByRole('dialog', { name: 'Task service ticket' })).toBeVisible(); expect(await screen.findByText('Loading saved ticket')).toBeVisible();
  expect(screen.queryByText('No Service ticket is linked to this task.')).not.toBeInTheDocument();
  await act(async () => finish(json({ title: 'Synthetic unavailable read' }, 503)));
  expect(await screen.findByText('Synthetic unavailable read')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Choose saved ticket' })).not.toBeInTheDocument();
  fireEvent(window, new Event('focus')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' })); await act(async () => finish(json(association())));
  expect(await screen.findByText('No Service ticket is linked to this task.')).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(2);
});

it('loads a bounded first page, filters only loaded rows and manually continues without touching Atera', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    return url.includes('/ticket?') ? json(association()) : pageOf(url.includes('cursor=') ? [otherTicket] : [ticket], url.includes('cursor=') ? null : 'page-two', 2);
  });
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' }));
  expect(await screen.findByRole('radio', { name: /#701/ })).toBeEnabled(); expect(screen.getByText('#701 · Synthetic saved ticket')).toBeVisible(); expect(screen.getByText('Showing 1 of 2')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter loaded tickets' }), { target: { value: '702' } });
  expect(screen.getByText('No loaded tickets match. Change the filter or load another page.')).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Load more' })); expect(await screen.findByRole('radio', { name: /#702/ })).toBeEnabled(); expect(screen.getByText('#702 · Synthetic second saved ticket')).toBeVisible();
  expect(screen.queryByRole('radio', { name: /#701/ })).not.toBeInTheDocument();
  expect(fetch.mock.calls[1]![0]).toBe('/api/v1/service/work-tickets?organizationId=customer-one&limit=50');
  expect(fetch.mock.calls[2]![0]).toBe('/api/v1/service/work-tickets?organizationId=customer-one&limit=50&cursor=page-two');
  expect(fetch.mock.calls.every(([, init]) => !init || (init as RequestInit).method === 'GET')).toBe(true);
});

it('discards a failed continuation and its selected row, then retries from the first page', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('/ticket?') ? json(association())
    : url.includes('cursor=') ? json({ title: 'Synthetic continuation failed' }, 503) : pageOf([ticket], 'next', 2));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' }));
  await userEvent.click(await screen.findByRole('radio', { name: /#701/ })); expect(screen.getByRole('button', { name: 'Link selected ticket' })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: 'Load more' })); await screen.findByText('Synthetic continuation failed');
  expect(screen.queryByRole('radio')).not.toBeInTheDocument(); expect(screen.queryByText('Showing 1 of 2')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Link selected ticket' })).toBeDisabled());
  await userEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByRole('radio', { name: /#701/ });
  expect(fetch.mock.calls.at(-1)![0]).not.toContain('cursor=');
});

it('uses the displayed ETag for exactly one rapid link submission, then explicitly unlinks the saved GUID', async () => {
  let saved = association(); let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT' ? new Promise<Response>(resolve => { finish = resolve; })
    : url.includes('/ticket?') ? json(saved) : pageOf());
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' }));
  await userEvent.click(await screen.findByRole('radio', { name: /#701/ })); const link = screen.getByRole('button', { name: 'Link selected ticket' });
  act(() => { fireEvent.click(link); fireEvent.click(link); }); await waitFor(() => expect(writes(fetch)).toHaveLength(1));
  expect(writes(fetch)[0]![1]).toMatchObject({ headers: { 'If-Match': '"association-version"' }, body: JSON.stringify({ organizationId: task.organizationId, ticketId: ticket.id }) });
  saved = association(ticket, { etag: '"linked-version"' }); await act(async () => finish(json(saved)));
  await userEvent.click(await screen.findByRole('button', { name: 'Unlink ticket' }));
  expect(writes(fetch)[1]![1]).toMatchObject({ headers: { 'If-Match': '"linked-version"' }, body: JSON.stringify({ organizationId: task.organizationId, ticketId: null }) });
  saved = association(); await act(async () => finish(json(saved))); expect(await screen.findByText('No Service ticket is linked to this task.')).toBeVisible();
});

it('retains a conflict for review without reread/retry and accepts a refreshed ETag only after explicit refresh', async () => {
  let version = '"first"'; const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT'
    ? json({ code: 'CONCURRENCY_CONFLICT' }, 412) : url.includes('/ticket?') ? json(association(ticket, { etag: version })) : pageOf());
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Unlink ticket' }));
  expect(await screen.findByText(/This task changed or the ticket is no longer available/)).toBeVisible(); expect(readCount(fetch)).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Unlink ticket' })); expect(writes(fetch)).toHaveLength(1);
  expect(screen.getByText(`#${ticket.externalId} · ${ticket.title}`)).toBeVisible(); version = '"reviewed"';
  await userEvent.click(screen.getByRole('button', { name: 'Refresh task ticket' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink ticket' })).not.toHaveAttribute('aria-disabled', 'true'));
  expect(screen.queryByText(/This task changed or the ticket is no longer available/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Unlink ticket' })); expect(writes(fetch)[1]![1].headers).toMatchObject({ 'If-Match': '"reviewed"' });
});

it('keeps an unavailable saved association explicit without exposing old ticket content or remapping', async () => {
  const fetch = vi.fn(async () => json(association(null, { ticketId: ticket.id, available: false })));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); expect(await screen.findByText(/^The linked ticket is no longer available/)).toBeVisible();
  expect(screen.queryByText(ticket.title)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Register hours' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Change saved ticket' })).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(1); expect(writes(fetch)).toHaveLength(0);
});

it.each([
  { permissions: ['activities.read'] }, { permissions: ['service.read'] }, { permissions: ['activities.write', 'service.read'] },
])('does not offer or read task tickets with incomplete read permissions $permissions', ({ permissions }) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); renderTaskTicket(permissions);
  expect(screen.queryByRole('button', { name: /^Service ticket for/ })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['Call', 'Meeting', 'Note', 'Email'] as const)('does not expose task work for %s records', type => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); renderTaskTicket(allowed, { ...task, type });
  expect(screen.queryByRole('button', { name: /^Service ticket for/ })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it('allows read-only task viewing and own hours independently from association write permission', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => auxiliary(url) ?? json(association(ticket)))); renderTaskTicket(['activities.read', 'service.read', 'time.own']); await open();
  expect(await screen.findByRole('button', { name: 'Register hours' })).toBeVisible(); expect(screen.queryByRole('button', { name: 'Unlink ticket' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Change saved ticket' })).not.toBeInTheDocument();
});
