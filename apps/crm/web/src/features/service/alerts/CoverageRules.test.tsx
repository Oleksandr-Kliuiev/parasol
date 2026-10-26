import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, syntheticAlert } from '../../../test/alerts';
import type { CoverageRule } from '../types';
import { AlertDetailDrawer } from './AlertDetailDrawer';
import { AlertQueuePage } from './AlertQueuePage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

const gap = syntheticAlert({
  id: 'g1', system: 'parasoll', externalId: 'atera.agent-silent:d1', title: 'The Atera agent on SRV-01 has not reported since 2026-10-12',
  rule: 'atera.agent-silent', facts: { device: 'SRV-01', lastSeenAt: '2026-10-12T08:00:00+00:00' }, machineId: 'm1',
});

const rule = (overrides: Partial<CoverageRule> = {}): CoverageRule => ({
  code: 'atera.agent-silent', system: 'atera', kind: 'Monitoring', threshold: { default: 7, min: 1, max: 90, unit: 'Days' }, enabled: true,
  value: 7, openGaps: 1, changedAt: null, changedByName: null, etag: '"AAAAAAAAC1E="', ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

function stub(rules: CoverageRule[] = [rule()]) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/service/coverage/rules/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { enabled: boolean; threshold: number };
      return json(rule({ enabled: body.enabled, value: body.threshold, changedAt: '2026-10-22T09:00:00Z', changedByName: 'Kari Nordmann' }));
    }
    if (url === '/api/v1/service/coverage/rules') return json(rules);
    if (url.startsWith('/api/v1/actions/kinds')) return json([]);
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    if (url === '/api/v1/service/alerts/g1') return json({ ...gap, etag: '"AAAAAAAAC1F="' });
    if (url.startsWith('/api/v1/service/alerts')) return json(alertPage([gap]));
    if (url.endsWith('/source-tasks/lookup')) return json({ items: [] });
    return json(empty);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Coverage gaps Parasoll finds (M40)', () => {
  it('words a gap in the reader’s language and offers only hiding it, no action at a source', async () => {
    const user = userEvent.setup();
    stub();
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    const title = await screen.findByRole('button', { name: /^The Atera agent on SRV-01 has not reported since .*12/ });
    expect(title).toBeVisible();
    expect(screen.getAllByText(/Source: Parasoll/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /^Actions for The Atera agent on SRV-01/ }));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Hide until…']);
  });

  it('says in the panel that Parasoll found the gap and how it closes, with no source to act at', async () => {
    const user = userEvent.setup();
    stub();
    renderRoutes([page(<AlertDetailDrawer alertId="g1" onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    expect(await screen.findByText(/Found by Parasoll’s own check\. It closes by itself once two checks in a row no longer find it\./)).toBeVisible();
    const own = within(screen.getByRole('region', { name: 'In Parasoll' }));
    expect(own.getByText(/Hiding a gap does not stop the check/)).toBeVisible();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).not.toContain('alert-source-g1');
    // The device leads to its card, and the gap to the setting of the check that found it.
    expect(screen.getByRole('link', { name: 'SRV-01' })).toHaveAttribute('href', '/organizations/o1?tab=drift&device=m1');
    await user.click(screen.getByRole('button', { name: 'Change the check' }));
    expect(await screen.findByRole('dialog', { name: 'Coverage checks' })).toBeVisible();
  });

  it('changes the limit of a check with the ETag it read, and refuses a limit out of its range', async () => {
    const user = userEvent.setup();
    const fetch = stub();
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    await user.click(await screen.findByRole('button', { name: 'Coverage checks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Coverage checks' });
    const check = within(await within(dialog).findByRole('region', { name: 'Silent Atera agent' }));
    expect(check.getByRole('switch', { name: 'Raise alerts' })).toBeChecked();
    expect(check.getByText('1 open alert · Not changed yet: the default applies')).toBeVisible();
    const days = check.getByRole('spinbutton', { name: /Days without contact/ });
    expect(days).toHaveValue(7);

    await user.clear(days); await user.type(days, '91');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await check.findByText('Enter a whole number from 1 to 90.')).toBeVisible();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    await user.clear(days); await user.type(days, '14');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [url, init] = fetch.mock.calls.find(([, call]) => call?.method === 'PUT')!;
    expect(url).toBe('/api/v1/service/coverage/rules/atera.agent-silent');
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAC1E="');
    expect(JSON.parse(String(init!.body))).toEqual({ enabled: true, threshold: 14 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Coverage checks' })).not.toBeInTheDocument());
  });

  it('says that switching a check off closes its open alerts, and shows a reader the checks without a way to change them', async () => {
    const user = userEvent.setup();
    stub();
    const { unmount } = renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    await user.click(await screen.findByRole('button', { name: 'Coverage checks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Coverage checks' });
    await user.click(await within(dialog).findByRole('switch', { name: 'Raise alerts' }));
    expect(within(dialog).getByText('Switching it off closes its open alerts at once.')).toBeVisible();
    unmount();

    stub([rule({ changedAt: '2026-10-21T09:00:00Z', changedByName: 'Ola Nordmann', value: 10 })]);
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read']));
    await user.click(await screen.findByRole('button', { name: 'Coverage checks' }));
    const readOnly = await screen.findByRole('dialog', { name: 'Coverage checks' });
    expect(within(readOnly).getByText('You can see the checks, but not change them.')).toBeVisible();
    expect(await within(readOnly).findByRole('switch', { name: 'Raise alerts' })).toBeDisabled();
    expect(within(readOnly).getByText(/Changed .* by Ola Nordmann/)).toBeVisible();
    expect(within(readOnly).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(readOnly).getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
