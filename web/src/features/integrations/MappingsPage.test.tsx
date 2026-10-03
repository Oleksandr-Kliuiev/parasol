import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IntegrationStatus, RecordPage } from '../../api/types';
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
    expect(screen.getByText('2 of 3 not linked')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/v1/integrations/records?system=poweroffice&type=Customer&state=Unlinked'))).toBe(true);

    await user.click(within(row).getByRole('button', { name: /Link to Havbris · name/ }));

    await waitFor(() => {
      const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toBe('/api/v1/integrations/links');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ system: 'poweroffice', externalType: 'Customer', externalId: '102', entityId: 'org-1' });
    });
  });
});
