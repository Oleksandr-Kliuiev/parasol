import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CurrentUser } from '../api/types';
import { testUser } from '../test/renderWithProviders';
import { AuthGate } from './AuthGate';
import { currentUserQueryKey } from './CurrentUserContext';

const asUser = (id: string): CurrentUser => ({ ...testUser(['sales.read']), id, roles: ['Crm.Sales'] });

afterEach(() => {
  window.sessionStorage.clear();
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

  it('says signing in waits during maintenance instead of sending the browser to sign in again (DEV-13)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === '/bff/maintenance'
        ? new Response(JSON.stringify({ mode: 'ReadOnly', since: '2026-10-04T08:00:00Z', reason: null }), { status: 200 })
        : new Response(JSON.stringify({ status: 401 }), { status: 401 })));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, search: '?maintenance=signin', assign, reload: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Signing in is paused')).toBeInTheDocument();
    expect(screen.queryByText('The app')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    // The operators who run the maintenance may sign in; they land on its page.
    screen.getByRole('button', { name: 'Operators: sign in' }).click();
    expect(assign).toHaveBeenCalledWith('/bff/login?returnUrl=%2Fadmin%2Fmaintenance');
  });

  it('sends a signed-out person to sign in when there is no maintenance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === '/bff/maintenance'
        ? new Response(JSON.stringify({ mode: 'Normal', since: null, reason: null }), { status: 200 })
        : new Response(JSON.stringify({ status: 401 }), { status: 401 })));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/quotes', search: '', assign, reload: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/bff/login?returnUrl=%2Fquotes'));
  });

  it('stops redirecting to sign-in after repeated attempts and says so', async () => {
    window.sessionStorage.setItem('crm.loginAttempts', JSON.stringify([Date.now() - 3_000, Date.now() - 2_000, Date.now() - 1_000]));
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === '/bff/maintenance'
        ? new Response(JSON.stringify({ mode: 'Normal', since: null, reason: null }), { status: 200 })
        : new Response(JSON.stringify({ status: 401 }), { status: 401 })));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/quotes', search: '', assign, reload: vi.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AuthGate>
          <p>The app</p>
        </AuthGate>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/did not complete after several attempts/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    window.sessionStorage.clear();
  });
});
