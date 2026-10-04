import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CurrentUser } from '../api/types';
import { testUser } from '../test/renderWithProviders';
import { AuthGate } from './AuthGate';
import { currentUserQueryKey } from './CurrentUserContext';

const asUser = (id: string): CurrentUser => ({ ...testUser(['sales.read']), id, roles: ['Crm.Sales'] });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthGate (DEV-09)', () => {
  it('drops everything cached and starts over when another person has signed in on the browser', async () => {
    let signedIn = asUser('u1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(signedIn), { status: 200 })));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, assign: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['sales', 'quotes', 'list'], [{ id: 'q-of-u1' }]);

    render(
      <QueryClientProvider client={client}>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('The app')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    signedIn = asUser('u2');
    await client.refetchQueries({ queryKey: currentUserQueryKey });

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(['sales', 'quotes', 'list'])).toBeUndefined();
  });

  it('keeps the cache when the same person is asked about again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(asUser('u1')), { status: 200 })));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, assign: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['sales', 'quotes', 'list'], [{ id: 'q-of-u1' }]);

    render(
      <QueryClientProvider client={client}>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('The app')).toBeInTheDocument();
    await client.refetchQueries({ queryKey: currentUserQueryKey });

    expect(reload).not.toHaveBeenCalled();
    expect(client.getQueryData(['sales', 'quotes', 'list'])).toEqual([{ id: 'q-of-u1' }]);
  });
});
