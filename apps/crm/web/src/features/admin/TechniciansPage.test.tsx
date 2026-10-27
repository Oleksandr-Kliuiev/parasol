import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import type { TechnicianMapping } from '../time/types';
import { TechniciansPage } from './TechniciansPage';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const technician = (overrides: Partial<TechnicianMapping> = {}): TechnicianMapping => ({
  id: 'm1', system: 'atera', externalId: '4001', name: 'Felles Atera', email: 'it@firm.example', userId: null, userName: null,
  shared: false, method: 'Unmapped', lastSeenAt: '2026-10-27T08:00:00Z', ...overrides,
});

describe('technicians', () => {
  it('shares the firm’s one Atera technician with everyone, and then asks for no person', async () => {
    let row = technician();
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { userId: string | null; shared: boolean };
        sent.push(body);
        row = technician({ shared: body.shared, method: body.shared ? 'Manual' : 'Unmapped' });
        return new Response(null, { status: 204 });
      }
      return String(input).includes('/api/v1/identity/technicians')
        ? json({ items: [row], nextCursor: null, totalCount: 1 })
        : json({ items: [], nextCursor: null, totalCount: 0 });
    }));
    renderRoutes([page(<TechniciansPage />, '/admin/technicians')], '/admin/technicians', testUser(['users.read', 'integrations.manage']));

    // Atera's number beside the e-mail tells the row that can write in Atera from one keyed by e-mail.
    expect(await screen.findByText('it@firm.example · #4001')).toBeVisible();
    // One picker per row, told apart by its technician.
    expect(screen.getByRole('combobox', { name: 'CRM user Felles Atera' })).toBeVisible();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared by everyone' }));

    await waitFor(() => expect(sent).toEqual([{ userId: null, shared: true }]));
    expect(await screen.findByText(/Everyone without a technician of their own writes in Atera as this one/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Shared by everyone' })).toBeChecked();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared by everyone' }));

    await waitFor(() => expect(sent).toEqual([{ userId: null, shared: true }, { userId: null, shared: false }]));
    expect(await screen.findByRole('combobox')).toBeVisible();
  }, 15_000);

  it('names a shared technician to someone who may not change the mapping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [technician({ shared: true, method: 'Manual' })], nextCursor: null, totalCount: 1 })));
    renderRoutes([page(<TechniciansPage />, '/admin/technicians')], '/admin/technicians', testUser(['users.read']));

    expect(await screen.findByText('Shared by everyone')).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Not mapped')).not.toBeInTheDocument();
  });

  it('shows each technician as a card on a narrow screen, with the person and the box on the first screen', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 840px)', media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/api/v1/identity/technicians')
      ? json({ items: [technician({ lastSeenAt: '2026-10-27T08:00:00Z' })], nextCursor: null, totalCount: 1 })
      : json({ items: [], nextCursor: null, totalCount: 0 })));
    renderRoutes([page(<TechniciansPage />, '/admin/technicians')], '/admin/technicians', testUser(['users.read', 'integrations.manage']));

    const list = await screen.findByRole('list', { name: 'Technicians' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const card = within(list).getByRole('listitem');
    expect(within(card).getByText('it@firm.example · #4001')).toBeVisible();
    expect(within(card).getByRole('combobox', { name: 'CRM user Felles Atera' })).toBeVisible();
    expect(within(card).getByRole('checkbox', { name: 'Shared by everyone' })).toBeInTheDocument();
    expect(within(card).getByText(/^Last seen:/)).toBeVisible();
  });
});
