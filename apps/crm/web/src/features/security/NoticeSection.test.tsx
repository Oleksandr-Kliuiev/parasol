import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { alertPage, alertRead, syntheticAlert } from '../../test/alerts';
import { AlertDetailDrawer } from '../service/alerts/AlertDetailDrawer';
import type { Alert } from '../service/types';
import type { Notice } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

const escalationAlert = syntheticAlert({
  id: 'e1', system: 'huntress', kind: 'Security', externalId: 'escalation:45', title: 'Login from an unexpected country', deviceName: null,
});
const platformAlert = syntheticAlert({
  id: 'p1', system: 'huntress', kind: 'Security', externalId: 'platform-action:9', title: 'Defender Disabled', deviceName: 'SRV-01',
});

/** An open unwanted-access escalation of the synthetic customer, about one account and one machine. */
const notice = (overrides: Partial<Notice> = {}): Notice => ({
  id: 'n1', system: 'huntress', kind: 'Escalation', externalId: 45, organizationId: 'o1', organizationName: 'Fjord IT AS', status: 'open', isOpen: true,
  severity: 'high', subject: 'Login from an unexpected country', type: 'Unwanted Access', typeCode: 'unexpected_country_access', subtype: 'US',
  entities: [{ type: 'Identity', id: 'i-1', name: 'kari@fjordit.example' }, { type: 'Agent', id: '4711', name: 'PC-17' }], allEntities: true,
  createdAt: '2026-10-21T06:00:00Z', resolvedAt: null, updatedAt: '2026-10-21T06:00:00Z', url: null, readAt: '2026-10-22T08:00:00Z',
  entitiesReadAt: '2026-10-22T08:00:00Z', ...overrides,
});

const preview = (request: { kind: string; targetType: string; targetId: string }) => ({
  previewToken: 'signed-token', expiresAt: '2026-10-22T08:10:00Z', system: 'huntress', kind: request.kind, level: 'Standard',
  target: { type: request.targetType, id: request.targetId, name: 'Login from an unexpected country', organizationId: 'o1', organizationName: 'Fjord IT AS',
    externalCustomerId: '501', url: null },
  effects: [], block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
});

afterEach(() => vi.unstubAllGlobals());

function show(alert: Alert, record: Notice, kinds: string[] = ['escalation.resolve'], permissions = ['service.read', 'service.write']) {
  const path = record.kind === 'Escalation' ? `/api/v1/security/huntress/escalations/${record.externalId}` : `/api/v1/security/huntress/platform-actions/${record.externalId}`;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds.map((kind) => ({ system: 'huntress', kind, targetType: 'alert', level: 'Standard',
      simulated: false, limitedToCustomers: false })));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') return json(preview(JSON.parse(String(init.body))));
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    if (url === `/api/v1/service/alerts/${alert.id}`) return json({ ...alert, etag: '"AAAAAAAAE1E="' });
    if (url === '/api/v1/service/alerts?limit=1') return json(alertPage([], null, 0, [alertRead({ system: 'huntress' })]));
    if (url === path) return json(record);
    return json(empty);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<AlertDetailDrawer alertId={alert.id} onClose={() => {}} />)], '/', testUser(permissions));
  return fetch;
}

async function previewed(fetch: ReturnType<typeof show>) {
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
  const [, init] = fetch.mock.calls.findLast(([url]) => url === '/api/v1/actions/preview')!;
  return JSON.parse(String(init!.body)) as Record<string, unknown>;
}

describe('A Huntress escalation or platform action in its alert’s panel (M41)', () => {
  it('lists what an access escalation is about and closes it with the answer chosen', async () => {
    const user = userEvent.setup();
    const fetch = show(escalationAlert, notice());
    const section = within(await screen.findByRole('region', { name: 'Escalation' }));
    expect(await section.findByText('Open')).toBeVisible();
    expect(section.getByText('Unwanted Access')).toBeVisible();
    const about = section.getAllByRole('listitem').map((item) => item.textContent);
    expect(about).toEqual(['kari@fjordit.example (account)', 'PC-17 (machine)']);

    const answers = within(await section.findByRole('radiogroup', { name: 'Answer' }));
    expect(answers.getAllByRole('radio').map((radio) => radio.closest('span')?.textContent ?? radio.getAttribute('value')))
      .toEqual(['The access was expected', 'The access was not expected', 'Just close it']);
    expect(answers.getByRole('radio', { name: 'The access was expected' })).toBeChecked();
    expect(section.getByText('Huntress allows the same access for these accounts from now on.')).toBeVisible();

    await user.click(answers.getByRole('radio', { name: 'The access was not expected' }));
    expect(section.getByText(/Block or disable the accounts in Huntress or Microsoft 365\./)).toBeVisible();
    await user.click(section.getByRole('button', { name: 'Close as unauthorised' }));
    expect(await screen.findByRole('dialog', { name: 'Close the escalation in Huntress' })).toBeVisible();
    expect(await previewed(fetch)).toEqual({
      system: 'huntress', kind: 'escalation.resolve', targetType: 'alert', targetId: 'escalation:45', parameters: { answer: 'unauthorized' },
    });
  });

  it('offers any other escalation only its plain closing', async () => {
    const user = userEvent.setup();
    const fetch = show(escalationAlert, notice({ type: 'Environmental Issue', typeCode: 'defender_disabled', subtype: null, entities: [] }));
    const section = within(await screen.findByRole('region', { name: 'Escalation' }));
    const close = await section.findByRole('button', { name: 'Close the escalation' });
    expect(section.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(section.getByText('Closes it without an answer; an access escalation opens again the next time.')).toBeVisible();
    await user.click(close);
    expect((await previewed(fetch)).parameters).toEqual({ answer: 'close' });
  });

  it('says a platform action closes in Huntress by itself and offers nothing to send', async () => {
    show(platformAlert, notice({ kind: 'PlatformAction', externalId: 9, subject: 'Defender Disabled', type: 'Environmental Issue', typeCode: 'platform_integration',
      entities: [{ type: 'Agent', id: '4711', name: 'SRV-01' }] }), ['escalation.resolve']);
    const section = within(await screen.findByRole('region', { name: 'Platform action' }));
    expect(await section.findByText(/It closes in Huntress by itself once what it reports is put right/)).toBeVisible();
    expect(section.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['SRV-01 (machine)']);
    expect(section.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers no closing while the kind is off, for a resolved escalation, or to a person who may only read', async () => {
    show(escalationAlert, notice(), []);
    let section = within(await screen.findByRole('region', { name: 'Escalation' }));
    await section.findByText('Unwanted Access');
    expect(section.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(section.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    show(escalationAlert, notice({ status: 'resolved', isOpen: false, resolvedAt: '2026-10-22T07:00:00Z' }));
    section = within(await screen.findByRole('region', { name: 'Escalation' }));
    expect(await section.findByText('Resolved')).toBeVisible();
    expect(section.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    show(escalationAlert, notice(), ['escalation.resolve'], ['service.read']);
    section = within(await screen.findByRole('region', { name: 'Escalation' }));
    await section.findByText('Unwanted Access');
    expect(section.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });

  it('says when Huntress names more than it gave', async () => {
    show(escalationAlert, notice({ allEntities: false }));
    const section = within(await screen.findByRole('region', { name: 'Escalation' }));
    expect(await section.findByText('Huntress names more than are shown here.')).toBeVisible();
  });
});
