import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResponse } from '../api/types';
import { renderRoutes, testUser } from '../test/renderWithProviders';
import { formatDate } from '../shared/utils/format';
import { GlobalSearch } from './GlobalSearch';

const LABEL = 'Search customers, devices and more';

const response: SearchResponse = {
  query: 'fjord',
  groups: [
    { group: 'organizations', items: [{ id: 'o1', title: 'Fjord IT AS', subtitle: '923 609 016 · Oslo', url: '/organizations/o1' }] },
    { group: 'contacts', items: [{ id: 'c1', title: 'Kari Fjord', subtitle: 'Fjord IT AS', url: '/contacts/c1' }] },
  ],
};

/** One hit of each operations group, as the server sends them: the customer in the subtitle, the rest as facts. */
const operations: SearchResponse = {
  query: 'dc01',
  groups: [
    {
      group: 'devices', more: true, items: [
        { id: 'm1', title: 'DC01', subtitle: 'Fjord IT AS', url: '/organizations/o1?tab=drift&device=m1', facts: { type: 'Server', os: 'Windows Server 2022', serial: '5CG1234ABC' } },
        { id: 'm2', title: 'DC01-OLD', subtitle: 'Fjord IT AS', url: '/organizations/o1?tab=drift&device=m2', facts: { type: 'Workstation', removedAt: '2026-09-01T08:00:00Z' } },
      ],
    },
    {
      group: 'alerts', items: [
        { id: 'a1', title: 'Atera agent PC-07 silent', subtitle: 'Fjord IT AS', url: '/alerts?alert=a1',
          facts: { device: 'DC01', lastSeenAt: '2026-10-01T08:00:00Z', severity: 'Warning', system: 'parasoll', rule: 'atera.agent-silent' } },
      ],
    },
    { group: 'tickets', items: [{ id: 't1', title: '#4711 DC01 restarts', subtitle: 'Fjord IT AS', url: '/tickets?ticket=t1', facts: { status: 'Closed', open: 'false' } }] },
    {
      group: 'backup', items: [
        { id: 'b1', title: 'Kari Nordmann', subtitle: 'Fjord IT AS', url: '/organizations/o1?tab=backup&search=kari%40fjord.example',
          facts: { services: 'Mail,OneDrive', address: 'kari@fjord.example' } },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GlobalSearch', () => {
  it('shows grouped results and opens the selected one with the keyboard', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/');

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'fjord');

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Fjord IT AS923 609 016 · Oslo', 'Kari FjordFjord IT AS']);
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/search?q=fjord&take=6');

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/contacts/c1'));
  });

  it('marks the first hit of the answer as the one Enter opens, also when Enter comes before the answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(response)));
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/');
    const box = screen.getByRole('combobox', { name: LABEL });

    // Typed and Enter at once: the answer is not there yet, and its first hit opens when it comes.
    await user.type(box, 'fjord{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/organizations/o1'));
  });

  it('highlights the first hit once its answer is in, and with nothing found Enter stays', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => json(url.includes('q=fjord') ? response : { query: 'nordlys', groups: [] }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/');
    const box = screen.getByRole('combobox', { name: LABEL });

    await user.type(box, 'fjord');
    const first = await screen.findByRole('option', { name: /^Fjord IT AS/ });
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));
    expect(box).toHaveAttribute('aria-activedescendant', first.id);

    await user.clear(box);
    await user.type(box, 'nordlys');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/');
    expect(box).not.toHaveAttribute('aria-activedescendant');
  });

  it('offers the menu entries the user may open as "Go to" commands and opens one with the keyboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ query: 'bil', groups: [] }), { status: 200 })));
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/', testUser(['customers.read', 'billing.read']));

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'in');

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['BillingFinance', 'InvoicesFinance']);
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/billing/invoices'));
  });

  it('never offers an entry the user has no right to open, and says where a search that found nothing looked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ query: 'bil', groups: [] }), { status: 200 })));
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/', testUser(['customers.read']));

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'billing');

    // Not inside the list, which holds options only; the same words, and where it looked, reach screen readers through the status.
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
    expect(screen.getByText('Searched in organizations and contacts.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Nothing found. Searched in organizations and contacts.');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('words the operations records in the reader’s language and says when a group found more than it shows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(operations)));
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/', testUser(['customers.read', 'service.read']));

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'dc01');

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'DC01Fjord IT AS · Server · Serial number: 5CG1234ABC',
      'DC01-OLDNo longer reportedFjord IT AS · Workstation',
      `The Atera agent on DC01 has not reported since ${formatDate('2026-10-01T08:00:00Z')}WarningFjord IT AS · DC01 · Source: Parasoll`,
      '#4711 DC01 restartsClosedFjord IT AS',
      'Kari NordmannFjord IT AS · Mail, OneDrive · kari@fjord.example',
    ]);
    expect(screen.getByRole('group', { name: 'Devices, More than 2 – add a word, such as the customer’s name' })).toBeInTheDocument();
    // Each hit names its kind in its description, for screen readers that skip the group's name.
    expect(options[3]).toHaveAccessibleDescription('Tickets');
    expect(screen.getByRole('group', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tickets' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Backup' })).toBeInTheDocument();
  });

  it('Page Down and Page Up move from group to group and keep the highlight in view', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(operations)));
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/', testUser(['customers.read', 'service.read']));
    const box = screen.getByRole('combobox', { name: LABEL });

    await user.type(box, 'dc01');
    const options = await screen.findAllByRole('option');
    const selected = () => options.findIndex((o) => o.getAttribute('aria-selected') === 'true');

    // Devices start at 0 (two hits), alerts at 2, tickets at 3, backups at 4; the first hit is marked once the answer is in.
    await waitFor(() => expect(selected()).toBe(0));
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(1);
    await user.keyboard('{PageUp}');
    expect(selected(), 'from inside a group to its first hit').toBe(0);
    await user.keyboard('{PageDown}{PageDown}');
    expect(selected()).toBe(3);
    expect(box).toHaveAttribute('aria-activedescendant', options[3]!.id);
    await user.keyboard('{PageUp}');
    expect(selected()).toBe(2);
    await user.keyboard('{PageUp}{PageUp}');
    expect(selected(), 'no group before the first').toBe(0);
    expect(scrolled).toHaveBeenCalled();

    await user.keyboard('{PageDown}{PageDown}{PageDown}{PageDown}{PageDown}');
    expect(selected()).toBe(4);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/organizations/o1?tab=backup&search=kari%40fjord.example'));
  });

  it('opens a hit on click, not on the press, and in a new tab with Ctrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(response)));
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch inline /> }], '/');

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'fjord');
    const contact = await screen.findByRole('option', { name: /^Kari Fjord/ });
    await user.pointer({ keys: '[MouseLeft>]', target: contact });
    expect(router.state.location.pathname, 'the press alone opens nothing').toBe('/');
    await user.pointer({ keys: '[/MouseLeft]', target: contact });
    await waitFor(() => expect(router.state.location.pathname).toBe('/contacts/c1'));

    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('option', { name: /^Fjord IT AS/ }));
    await user.keyboard('{/Control}');
    expect(opened).toHaveBeenCalledWith('/organizations/o1', '_blank', 'noopener');
  });

  it('lists the groups it found under the field, and a group button moves the highlight to that group', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(operations)));
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch inline /> }], '/', testUser(['customers.read', 'service.read']));
    const box = screen.getByRole('combobox', { name: LABEL });

    await user.type(box, 'dc01');
    const jumps = within(await screen.findByRole('group', { name: 'Groups with hits' }));
    expect(jumps.getAllByRole('button').map((b) => b.textContent)).toEqual(['Devices 2+', 'Alerts 1', 'Tickets 1', 'Backup 1']);
    await user.click(jumps.getByRole('button', { name: 'Tickets 1' }));
    expect(screen.getByRole('option', { name: /^#4711/ })).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/tickets?ticket=t1'));
  });

  it('says when the search failed and asks again on request', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ title: 'Server error' }, 500)).mockResolvedValue(json(response));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <GlobalSearch inline /> }], '/', testUser(['customers.read']));

    await user.type(screen.getByRole('combobox', { name: LABEL }), 'fjord');

    expect(await screen.findByRole('alert')).toHaveTextContent('The search failed.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /^Fjord IT AS 923 609 016/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // The button went while the search was read again: focus is back in the field, not lost on the page.
    expect(screen.getByRole('combobox', { name: LABEL })).toHaveFocus();
  });
});
