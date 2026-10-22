import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IntegrationStatus, RecordPage } from '../../api/types';
import { holdSearch } from '../../test/heldSearch';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { MappingsPage } from './MappingsPage';

const status: IntegrationStatus[] = [
  {
    system: 'poweroffice', enabled: true, recordTypes: ['Customer', 'ContactPerson', 'Product'], records: 3, unlinked: 2,
    pendingOutbound: 0, failedOutbound: 0, paused: false, pauseReason: null, pausedAt: null, pausedBy: null,
  },
  {
    system: 'atera', enabled: false, recordTypes: ['Customer', 'Contact'], records: 0, unlinked: 0,
    pendingOutbound: 0, failedOutbound: 0, paused: false, pauseReason: null, pausedAt: null, pausedBy: null,
  },
];

const page: RecordPage = {
  total: 3,
  unlinked: 2,
  nextCursor: null,
  items: [
    {
      id: 'r1', system: 'poweroffice', externalType: 'Customer', externalId: '102', displayName: 'Havbris AS', orgNumber: '923609016', email: 'post@havbris.no',
      phone: null, domain: null, parentExternalId: null, lastSeenAt: '2026-09-15T10:00:00Z', externalChangedAt: null, isGone: false, link: null,
      suggestions: [{ entityId: 'org-1', name: 'Havbris', orgNumber: null, reasons: ['SameName'] }],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('MappingsPage', () => {
  it('shows unlinked records with suggestions and links on click', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'l1' }), { status: 200 });
      if (url.startsWith('/api/v1/integrations/status')) return new Response(JSON.stringify(status), { status: 200 });
      return new Response(JSON.stringify(page), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '/admin/mappings', element: <MappingsPage /> }], '/admin/mappings', testUser(['integrations.manage']));

    const row = (await screen.findByText('Havbris AS')).closest('tr')!;
    expect(within(row).getByText('923 609 016')).toBeInTheDocument();
    // The link states are chips with their counts: 2 of the 3 records are not linked.
    expect(screen.getByRole('button', { name: 'Not linked, 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Linked, 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All, 3' })).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/v1/integrations/records?system=poweroffice&type=Customer&state=Unlinked'))).toBe(true);

    await user.click(within(row).getByRole('button', { name: /Link to Havbris · name/ }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toBe('/api/v1/integrations/links');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ system: 'poweroffice', externalType: 'Customer', externalId: '102', entityId: 'org-1' });
    });
  });

  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  describe('while a search is read', () => {
    const empty: RecordPage = { total: 0, unlinked: 0, nextCursor: null, items: [] };
    const answers = (url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { id: 'l1' }
      : url.startsWith('/api/v1/integrations/status') ? status : url.includes('search=Nothing') ? empty : page), { status: 200 });
    const render = () => renderRoutes([{ path: '/admin/mappings', element: <MappingsPage /> }], '/admin/mappings', testUser(['integrations.manage']));

    it('keeps the rows and the room of the state counts in place, so a button in a row still works, and claims no empty answer', async () => {
      const { fetch, requested, answer } = holdSearch((url) => /search=Hav/.test(url), answers);
      vi.stubGlobal('fetch', fetch);
      render();
      await screen.findByText('Havbris AS');
      const search = screen.getByRole('searchbox', { name: 'Search name, number, e-mail' });

      // An empty answer is not repeated while another search is read.
      fireEvent.change(search, { target: { value: 'Nothing' } });
      expect(await screen.findByText('No records. They appear after the first synchronization.')).toBeVisible();
      fireEvent.change(search, { target: { value: 'Havbris' } });
      await requested();
      expect(screen.queryByText('No records. They appear after the first synchronization.')).not.toBeInTheDocument();
      await answer(page);
      const row = (await screen.findByText('Havbris AS')).closest('tr')!;
      expect(screen.getByRole('button', { name: 'Not linked, 2' })).toBeVisible();

      // The same row with its buttons; the counts on the states are of the earlier search, so they keep their room unseen.
      fireEvent.change(search, { target: { value: 'Hav' } });
      await requested();
      expect(screen.getByText('Havbris AS').closest('tr')).toBe(row);
      expect(screen.getByRole('table', { name: 'Mappings' })).toHaveAttribute('aria-busy', 'true');
      expect(within(screen.getByRole('button', { name: 'Not linked' })).getByText('2')).not.toBeVisible();
      await userEvent.click(within(row).getByRole('button', { name: /Link to Havbris · name/ }));
      await waitFor(() => {
        const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({ system: 'poweroffice', externalType: 'Customer', externalId: '102', entityId: 'org-1' });
      });
    }, 15_000);

    it('does not keep the rows of one system while another is read: their buttons would act with the wrong system', async () => {
      const { fetch, requested } = holdSearch((url) => url.includes('system=atera'), answers);
      vi.stubGlobal('fetch', fetch);
      render();
      await screen.findByText('Havbris AS');
      await userEvent.click(screen.getByRole('tab', { name: 'Atera' }));
      await requested();
      expect(screen.queryByText('Havbris AS')).not.toBeInTheDocument();
      expect(screen.queryByText('No records. They appear after the first synchronization.')).not.toBeInTheDocument();
    }, 15_000);
  });
});
