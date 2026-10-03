import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DuplicatePair, MergeListItem } from '../../api/types';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { DuplicatesPage } from './DuplicatesPage';

const pair: DuplicatePair = {
  first: { id: 'a', name: 'Havbris AS', orgNumber: null, status: 'Prospect', city: 'Bergen', email: 'post@havbris.no', phone: null, domains: ['havbris.no'], activeContacts: 0, createdAt: '2026-09-01T10:00:00Z' },
  second: { id: 'b', name: 'Havbris', orgNumber: '923609016', status: 'Customer', city: 'Oslo', email: 'post@havbris.no', phone: null, domains: ['havbris.no'], activeContacts: 2, createdAt: '2026-01-01T10:00:00Z' },
  reasons: ['SameName', 'SharedDomain'],
};

function mockApi(merges: MergeListItem[] = []) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ mergeId: 'm1', targetOrganizationId: 'b', sourceOrganizationId: 'a', movedContacts: 0 }), { status: 200 });
    if (url.includes('/merges')) return new Response(JSON.stringify(merges), { status: 200 });
    return new Response(JSON.stringify([pair]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('DuplicatesPage', () => {
  it('compares both organizations, highlights differences and merges after confirmation', async () => {
    const fetch = mockApi();
    const user = userEvent.setup();
    renderRoutes([{ path: '/organizations/duplicates', element: <DuplicatesPage /> }], '/organizations/duplicates', testUser(['customers.read', 'customers.write', 'customers.delete']));

    const card = await screen.findByRole('region', { name: 'Havbris AS / Havbris' });
    expect(within(card).getByText('Same name')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Keep this one: Havbris' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge Havbris AS into Havbris?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/v1/customers/organizations/b/merge');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ sourceOrganizationId: 'a' });
  });

  it('hides merge and dismiss actions without permissions', async () => {
    mockApi();
    renderRoutes([{ path: '/organizations/duplicates', element: <DuplicatesPage /> }], '/organizations/duplicates', testUser(['customers.read']));

    await screen.findByRole('region', { name: 'Havbris AS / Havbris' });
    expect(screen.queryByRole('button', { name: /Keep this one/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not duplicates' })).not.toBeInTheDocument();
  });
});
