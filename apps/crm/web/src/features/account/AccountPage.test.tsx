import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CurrentUser } from '../../api/types';
import { ThemeModeProvider } from '../../app/themeMode';
import { changeLanguage } from '../../i18n';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { NotificationsPage } from '../notifications/NotificationsPage';
import { AccountPage } from './AccountPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const preferences = { emailEnabled: true, digestHour: 7, mutedKinds: [], emailAvailable: true };

afterEach(async () => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  // The language test switches the whole app; the next test starts in English again.
  await changeLanguage('en');
});

function stubApi() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/notifications/preferences') return json(init?.method === 'PUT' ? { ...preferences, ...JSON.parse(String(init.body)) } : preferences);
    if (url.startsWith('/api/v1/notifications')) return json({ unread: 0, items: [], nextCursor: null, totalCount: 0 });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const puts = (fetch: ReturnType<typeof stubApi>, url: string) =>
  fetch.mock.calls.filter(([u, init]) => u === url && init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));

const employee = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  ...testUser(['time.manage', 'billing.read']),
  email: 'kari@vardahei.no',
  roles: ['Crm.Admin'],
  authMode: 'Entra',
  jobTitle: 'Technician',
  department: 'Operations',
  lastLoginAt: '2026-10-27T07:30:00Z',
  ...overrides,
});

const renderAccount = (user: CurrentUser = employee(), path = '/account') =>
  renderRoutes([page(<ThemeModeProvider><AccountPage /></ThemeModeProvider>, '/account'), page(<NotificationsPage />, '/notifications')], path, user);

describe('AccountPage', () => {
  it('shows who the person is signed in as, with full access in words', async () => {
    stubApi();
    renderAccount();

    const profile = screen.getByRole('region', { name: 'Profile' });
    expect(within(profile).getByText('Kari Nordmann')).toBeInTheDocument();
    expect(within(profile).getByText('kari@vardahei.no')).toBeInTheDocument();
    expect(within(profile).getByText('Technician · Operations')).toBeInTheDocument();
    expect(within(profile).getByText('Full access')).toBeInTheDocument();
    expect(within(profile).getByText('Microsoft Entra ID')).toBeInTheDocument();
    expect(within(profile).getByText(/come from Microsoft Entra ID/)).toBeInTheDocument();
    expect(profile.querySelector('time')).toHaveAttribute('dateTime', '2026-10-27T07:30:00Z');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('names narrower roles and leaves out what the directory did not give', async () => {
    stubApi();
    renderAccount(employee({ roles: ['Crm.Technician', 'Crm.Sales'], jobTitle: null, department: null, authMode: 'Development' }));

    const profile = screen.getByRole('region', { name: 'Profile' });
    expect(within(profile).getByText('Technician, Sales')).toBeInTheDocument();
    expect(within(profile).getByText('Development sign-in')).toBeInTheDocument();
    expect(within(profile).queryByText(/·/)).not.toBeInTheDocument();
  });

  it('saves the language and the My day layout with the account', async () => {
    const fetch = stubApi();
    renderAccount();
    const settings = screen.getByRole('region', { name: 'Settings' });

    await userEvent.click(within(within(settings).getByRole('radiogroup', { name: 'My day shows first' })).getByRole('radio', { name: 'Billing' }));
    await waitFor(() => expect(puts(fetch, '/api/v1/identity/me/my-day-layout')).toEqual([{ layout: 'finance' }]));

    const language = within(settings).getByRole('radiogroup', { name: 'Language' });
    expect(within(language).getByRole('radio', { name: 'English' })).toBeChecked();
    await userEvent.click(within(language).getByRole('radio', { name: 'Norsk bokmål' }));
    await waitFor(() => expect(puts(fetch, '/api/v1/identity/me/preferences')).toEqual([{ language: 'nb' }]));
    // The page follows once the choice is saved.
    await waitFor(() => expect(document.documentElement.lang).toBe('nb'));
  });

  it('keeps the theme in this browser only', async () => {
    const fetch = stubApi();
    renderAccount();
    const theme = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(theme).getByRole('radio', { name: 'Same as system' })).toBeChecked();

    await userEvent.click(within(theme).getByRole('radio', { name: 'Dark' }));

    expect(within(theme).getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('parasoll-theme')).toBe('dark');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('offers no My day choice to someone with one layout', () => {
    stubApi();
    renderAccount(employee({ permissions: [] }));
    expect(screen.queryByRole('radiogroup', { name: 'My day shows first' })).not.toBeInTheDocument();
  });

  it('holds the e-mail settings, and the notifications page leads there', async () => {
    const fetch = stubApi();
    const { router } = renderAccount(employee(), '/notifications');

    await userEvent.click(screen.getByRole('link', { name: 'E-mail settings' }));
    expect(router.state.location.pathname).toBe('/account');
    expect(router.state.location.hash).toBe('#notifications');

    const panel = await screen.findByRole('region', { name: 'E-mail and reminders' });
    await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Contracts ending' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(fetch, '/api/v1/notifications/preferences')).toEqual([{ emailEnabled: true, digestHour: 7, mutedKinds: ['ContractEnding'] }]));
  });
});
