import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import type { ServiceSourceRead, Ticket, TicketComment, TicketDetail } from '../types';
import { TicketsPage } from './TicketsPage';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const read = (source: ServiceSourceRead['source'], startedAt: string | null = '2026-10-21T10:00:00Z'): ServiceSourceRead =>
  ({ source, system: 'atera', startedAt, complete: startedAt !== null, late: false });

const ticket = (id: string, changes: Partial<Ticket> = {}): Ticket => ({
  id, externalId: 4711, organizationId: 'o1', organizationName: 'Havbris AS', contactId: null, contactName: 'Kari Kunde', title: 'Printer is down',
  status: 'Open', isOpen: true, priority: 'High', type: 'Incident', technicianName: 'Tor Tekniker', createdAt: '2026-10-21T08:00:00Z', resolvedAt: null,
  lastActivityAt: '2026-10-21T09:00:00Z', url: 'https://atera.example/ticket/4711', ...changes,
});

const detail = (changes: Partial<TicketDetail> = {}): TicketDetail => ({
  ...ticket('t1'), system: 'atera', endUserEmail: 'kari@example.no', impact: null, source: 'Email', technicianUserId: null, firstResponseAt: null,
  commentsReadAt: '2026-10-21T10:01:00Z', ticketsRead: read('tickets'), conversationsRead: read('conversations'), ...changes,
});

const comment = (id: string, text: string, changes: Partial<TicketComment> = {}): TicketComment => ({
  id, externalId: id, text, isInternal: false, author: 'EndUser', authorName: 'Kari Kunde', technicianUserId: null, createdAt: '2026-10-21T08:00:00Z', ...changes,
});

const emptyLog = { items: [], nextCursor: null, totalCount: 0, uncertain: 0, waiting: 0 };

function api(overrides: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const custom = overrides(url, init);
    if (custom) return custom;
    if (url === '/api/v1/service/reads') return json([read('tickets'), read('conversations'), read('alerts'), read('devices')]);
    if (url.startsWith('/api/v1/service/tickets?')) return json({ items: [ticket('t1'), ticket('t2', { externalId: 4712, title: 'Outlook crashes', isOpen: true, priority: null })], nextCursor: null, totalCount: 2 });
    if (url === '/api/v1/service/tickets/t1') return json(detail());
    if (url.startsWith('/api/v1/service/tickets/t1/comments')) {
      // Newest first from the server.
      return url.includes('cursor=c1')
        ? json({ items: [comment('c1', 'The first message')], nextCursor: null, totalCount: 3 })
        : json({ items: [comment('c3', 'Internal: check the driver', { isInternal: true, author: 'Technician', authorName: 'Tor Tekniker' }),
          comment('c2', 'We are looking at it', { author: 'Technician', authorName: 'Tor Tekniker' })], nextCursor: 'c1', totalCount: 3 });
    }
    if (url.startsWith('/api/v1/actions?')) return json(emptyLog);
    return json({}, 404);
  });
}

const render = (path = '/tickets', permissions = ['service.read', 'service.write']) =>
  renderRoutes([page(<TicketsPage />, 'tickets')], path, testUser(permissions));

describe('tickets (M39.2)', () => {
  it('lists the tickets of every customer with their read time, and filters to open and mine in the address', async () => {
    const fetch = api(); vi.stubGlobal('fetch', fetch);
    const { router } = render();
    expect(await screen.findByRole('button', { name: '#4711 Printer is down' })).toBeVisible();
    expect(screen.getByText('2 open tickets')).toBeVisible();
    expect(screen.getByText(/^Open tickets \(Atera\) read at .* · Ticket messages \(Atera\) read at /)).toBeVisible();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/tickets?openOnly=true&limit=25');

    await userEvent.click(screen.getByRole('button', { name: 'Mine' }));
    await waitFor(() => expect(router.state.location.search).toBe('?mine=1'));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/tickets?openOnly=true&mine=true&limit=25'));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/tickets?mine=true&limit=25'));
  });

  it('opens a ticket in its own panel with its facts, both read times and the conversation oldest first', async () => {
    vi.stubGlobal('fetch', api());
    const { router } = render();
    await userEvent.click(await screen.findByRole('button', { name: '#4711 Printer is down' }));
    expect(router.state.location.search).toBe('?ticket=t1');
    const panel = await screen.findByRole('dialog', { name: '#4711 Printer is down' });
    expect(within(panel).getByText('Havbris AS')).toBeVisible();
    expect(within(panel).getByText('Kari Kunde · kari@example.no')).toBeVisible();
    // The panel says how fresh the ticket list is; the conversation says when this ticket's messages were read.
    expect(within(panel).getByText(/^Open tickets \(Atera\) read at [^·]*$/)).toBeVisible();
    expect(within(panel).getByRole('link', { name: /Open in Atera/ })).toHaveAttribute('href', 'https://atera.example/ticket/4711');

    const conversation = within(within(panel).getByRole('region', { name: 'Conversation' }));
    await waitFor(() => expect(conversation.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent))
      .toEqual(['We are looking at it', 'Internal: check the driver']));
    expect(within(conversation.getAllByRole('listitem')[1]!).getByText('Internal note')).toBeVisible();
    await userEvent.click(conversation.getByRole('button', { name: 'Show earlier messages (2 of 3)' }));
    await waitFor(() => expect(conversation.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent))
      .toEqual(['The first message', 'We are looking at it', 'Internal: check the driver']));
  });

  it('sends a reply through the action confirmation and empties the box once the command is saved', async () => {
    let saved = false;
    const fetch = api((url, init) => {
      if (url === '/api/v1/actions/preview') return json({
        previewToken: 'token', expiresAt: null, system: 'atera', kind: 'ticket.reply', level: 'Standard',
        target: { type: 'ticket', id: '4711', name: '#4711 Printer is down', organizationId: 'o1', organizationName: 'Havbris AS', externalCustomerId: '17', url: null },
        effects: [{ code: 'VND_EFFECT_TICKET_REPLY', values: { to: 'Kari Kunde' } }, { code: 'VND_EFFECT_TICKET_AUTHOR', values: { name: 'Tor Tekniker' } }],
        block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
      });
      if (url === '/api/v1/actions' && init?.method === 'POST') {
        saved = true;
        return json({ id: 'a1', system: 'atera', kind: 'ticket.reply', level: 'Standard', targetType: 'ticket', targetId: '4711', targetName: '#4711 Printer is down',
          organizationId: 'o1', organizationName: 'Havbris AS', parameters: { text: 'On my way' }, reason: null, status: 'Succeeded', outcomeCode: 'VND_SENT',
          outcome: 'Sent', reference: '900', attempts: 1, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-10-21T10:00:00Z',
          notBefore: '2026-10-21T10:00:00Z', startedAt: null, completedAt: null, closedBy: null, closedByName: null, closedAt: null, closeReason: null, etag: '"1"' }, 202);
      }
      return null;
    });
    vi.stubGlobal('fetch', fetch);
    render('/tickets?ticket=t1');
    const panel = await screen.findByRole('dialog', { name: '#4711 Printer is down' });
    const box = within(panel).getByRole('textbox', { name: 'Reply' });
    fireEvent.change(box, { target: { value: '  On my way  ' } });
    await userEvent.click(within(panel).getByRole('button', { name: 'Send the reply' }));

    const confirm = await screen.findByRole('dialog', { name: 'Reply in #4711' });
    expect(await within(confirm).findByText('Kari Kunde sees this reply in Atera, and gets it by e-mail when Atera\'s notifications are on.')).toBeVisible();
    expect(within(confirm).getByText('Atera shows it as written by Tor Tekniker.')).toBeVisible();
    expect(within(confirm).getByText('On my way')).toBeVisible();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Send the reply' }));
    expect(await within(confirm).findByText('The vendor accepted the change.')).toBeVisible();
    expect(saved).toBe(true);
    const command = JSON.parse(fetch.mock.calls.find(([url, init]) => url === '/api/v1/actions' && init?.method === 'POST')![1]!.body as string);
    expect(command).toMatchObject({ system: 'atera', kind: 'ticket.reply', targetType: 'ticket', targetId: '4711', parameters: { text: 'On my way' } });
    expect(box).toHaveValue('');
  });

  it('names the author of a message once, also when the desk gave no name', async () => {
    vi.stubGlobal('fetch', api((url) => url.startsWith('/api/v1/service/tickets/t1/comments')
      ? json({ items: [comment('c5', 'From the portal', { authorName: null, author: 'Unknown' }), comment('c4', 'Still broken', { authorName: null })], nextCursor: null, totalCount: 2 })
      : null));
    render('/tickets?ticket=t1');
    const panel = await screen.findByRole('dialog', { name: '#4711 Printer is down' });
    const items = await within(within(panel).getByRole('region', { name: 'Conversation' })).findAllByRole('listitem');
    expect(items.map((item) => item.firstElementChild?.textContent?.replace(/just now|\d+ \w+ ago|now/g, '').trim())).toEqual(['Customer', 'Message']);
  });

  it('says in its row which ticket has an action to check, from one lookup per page of rows', async () => {
    const fetch = api((url) => url === '/api/v1/actions/lookup'
      ? json({ items: [{ targetId: '4711', waiting: 0, done: 1, uncertain: 1, checkId: 'a1' }] })
      : null);
    vi.stubGlobal('fetch', fetch);
    render();
    const marked = (await screen.findByRole('button', { name: '#4711 Printer is down' })).closest('li')!;
    expect(await within(marked).findByText('Check needed')).toBeVisible();
    expect(within(screen.getByRole('button', { name: '#4712 Outlook crashes' }).closest('li')!).queryByText('Check needed')).not.toBeInTheDocument();
    const lookups = fetch.mock.calls.filter(([url]) => url === '/api/v1/actions/lookup');
    expect(lookups).toHaveLength(1);
    expect(JSON.parse(lookups[0]![1]!.body as string)).toEqual({ system: 'atera', targetType: 'ticket', targetIds: ['4711', '4712'] });
  });

  it('opens a notice\'s ticket with the card of its action over it, and closing the card keeps the ticket', async () => {
    const uncertain = {
      id: 'a1', system: 'atera', kind: 'ticket.reply', level: 'Standard', targetType: 'ticket', targetId: '4711', targetName: '#4711 Printer is down',
      organizationId: 'o1', organizationName: 'Havbris AS', parameters: { text: 'On my way' }, reason: null, status: 'Uncertain', outcomeCode: 'VND_NO_ANSWER',
      outcome: 'No answer.', reference: null, attempts: 1, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-10-21T10:00:00Z',
      notBefore: '2026-10-21T10:00:00Z', startedAt: null, completedAt: '2026-10-21T10:00:05Z', closedBy: null, closedByName: null, closedAt: null,
      closeReason: null, ticketId: 't1', vendorUrl: 'https://atera.example/ticket/4711', etag: '"1"',
    };
    vi.stubGlobal('fetch', api((url) => (url === '/api/v1/actions/a1' ? json(uncertain) : null)));
    const { router } = render('/tickets?ticket=t1&action=a1');
    const card = await screen.findByRole('dialog', { name: 'Reply to the customer · #4711 Printer is down' });
    expect(within(card).getByRole('link', { name: 'Check in Atera' })).toHaveAttribute('href', 'https://atera.example/ticket/4711');
    expect(within(card).queryByRole('link', { name: 'Open the ticket' })).not.toBeInTheDocument();
    expect(within(card).getByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible();
    await userEvent.click(within(card).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(router.state.location.search).toBe('?ticket=t1'));
    expect(screen.getByRole('dialog', { name: '#4711 Printer is down' })).toBeVisible();
  });

  it('offers no changes to someone who only reads service data', async () => {
    vi.stubGlobal('fetch', api());
    render('/tickets?ticket=t1', ['service.read']);
    const panel = await screen.findByRole('dialog', { name: '#4711 Printer is down' });
    expect(within(panel).queryByRole('group', { name: 'Change the ticket' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Conversation' })).toBeVisible();
  });

  it('says No access without reading anything to someone without service data', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render('/tickets', ['customers.read']);
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
