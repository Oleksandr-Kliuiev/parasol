import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@fluentui/react-components';
import type { OutboxMessageItem, OutboxOverview } from '../../api/types';
import { TOASTER_ID } from '../../app/toaster';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { DeliveryPanel } from './DeliveryPanel';

const message = (id: string, overrides: Partial<OutboxMessageItem> = {}): OutboxMessageItem => ({
  id,
  module: 'contracts',
  eventType: 'QuoteAccepted',
  status: 'DeadLetter',
  occurredAt: '2026-10-04T08:00:00Z',
  attempts: 10,
  replays: 0,
  nextAttemptAt: null,
  deadLetteredAt: '2026-10-04T09:30:00Z',
  lastError: 'QuoteAcceptedHandler: timeout',
  deliveredHandlers: [],
  payloadBytes: 512,
  payloadFields: ['quoteId', 'organizationId'],
  replayRequested: false,
  ...overrides,
});

const overview: OutboxOverview = {
  counts: [{ module: 'contracts', pending: 0, processing: 0, deadLetter: 2, quarantined: 1 }],
  items: [
    message('m1'),
    message('m2', { module: 'billing', replays: 3, eventType: 'QuoteAccepted', deliveredHandlers: ['QuoteAcceptedChargeHandler'] }),
    message('m3', { status: 'Quarantined', eventType: 'ProjectPhaseBillable', replayRequested: true, attempts: 1 }),
  ],
};

function stubFetch(replay: (body: unknown) => Response, data = overview) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/v1/integrations/outbox/replay') return replay(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const openedDialog = (title: string) => screen.findByRole('dialog', { name: title });

function render() {
  renderRoutes(
    [{ path: '/admin', element: <><Toaster toasterId={TOASTER_ID} /><DeliveryPanel /></> }],
    '/admin',
    testUser(['integrations.manage']),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('DeliveryPanel', () => {
  it('caps concrete selection at 100 without silently dropping selected messages', async () => {
    stubFetch(() => new Response(), { counts: [], items: Array.from({ length: 101 }, (_, i) => message(`bulk-${i}`, { eventType: `Event${i}` })) });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: 'Replay selected (100)' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /^Select Event100 / })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /^Select Event0 / }));
    expect(screen.getByRole('checkbox', { name: /^Select Event100 / })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: /^Select Event100 / }));
    await user.click(screen.getByRole('button', { name: 'Replay selected (100)' }));
    const dialog = await openedDialog('Replay 100 messages?');
    const selection = within(dialog).getByRole('list', { name: 'Exact selection' });
    expect(within(selection).getAllByRole('listitem')).toHaveLength(100);
    expect(selection).toHaveTextContent('bulk-100');
    expect(selection).not.toHaveTextContent(/bulk-0 ·/);
  }, 30_000);

  it('shows undelivered events without their payload and replays the selected ones after a confirmed reason', async () => {
    let sent: unknown;
    stubFetch((body) => {
      sent = body;
      return new Response(JSON.stringify({ requested: 2, modules: ['contracts', 'billing'] }), { status: 202 });
    });
    const user = userEvent.setup();
    render();

    expect(await screen.findByText('contracts: 2 dead letters, 1 quarantined, 0 waiting for delivery')).toBeInTheDocument();
    expect(screen.getAllByText('contracts · fields: quoteId, organizationId')).toHaveLength(2);
    // Already requested: shown as such and not selectable again.
    expect(screen.getByText('Replay requested')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Select ProjectPhaseBillable/ })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Replay selected (2)' }));

    const dialog = await openedDialog('Replay 2 messages?');
    const confirm = within(dialog).getByRole('button', { name: 'Replay 2 messages' });
    expect(within(dialog).getByText('QuoteAccepted: 2')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    await user.type(reason, 'short');
    expect(confirm).toBeDisabled();
    await user.click(reason);
    await user.paste(' — timeout in PowerOffice fixed');
    await user.click(confirm);

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent).toEqual({
      messages: [
        { module: 'contracts', id: 'm1', replays: 0 },
        { module: 'billing', id: 'm2', replays: 3 },
      ],
      reason: 'short — timeout in PowerOffice fixed',
      expected: 2,
    });
    expect(await screen.findByText('Replay of 2 messages requested; crm-worker delivers them within seconds.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }, 20_000);

  it('reports partially requested and unknown outcomes in the dialog', async () => {
    stubFetch(() => new Response(JSON.stringify({ code: 'OUTBOX_REPLAY_PARTIAL', items: [
      { module: 'contracts', id: 'm1', status: 'Requested' }, { module: 'billing', id: 'm2', status: 'Unknown' },
    ] }), { status: 409 }));
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Replay selected (2)' }));
    const dialog = await openedDialog('Replay 2 messages?');
    await user.click(within(dialog).getByRole('textbox', { name: /Reason/ }));
    await user.paste('Handler fixed in release 42');
    await user.click(within(dialog).getByRole('button', { name: 'Replay 2 messages' }));
    const results = await within(dialog).findByRole('list', { name: 'Results by operation' });
    expect(results).toHaveTextContent('contracts / m1: Requested');
    expect(results).toHaveTextContent('billing / m2: Outcome unknown — verify before retrying');
  }, 20_000);

  it('keeps the dialog open with the reason when the list changed before the confirmation', async () => {
    const fetch = stubFetch(
      () =>
        new Response(JSON.stringify({ status: 409, title: 'OUTBOX_REPLAY_STALE', code: 'OUTBOX_REPLAY_STALE', items: [{ module: 'contracts', id: 'm1', status: 'Stale' }] }), {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    );
    const user = userEvent.setup();
    render();

    const replayButtons = await screen.findAllByRole('button', { name: 'Replay' });
    await user.click(replayButtons[0]!);
    const dialog = await openedDialog('Replay 1 message?');
    await user.click(within(dialog).getByRole('textbox', { name: /Reason/ }));
    await user.paste('Handler fixed in release 42');
    await user.click(within(dialog).getByRole('button', { name: 'Replay 1 message' }));

    expect(await within(dialog).findByText('The list changed meanwhile: some messages were replayed or delivered already. Check the list and confirm again.')).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Results by operation' })).toHaveTextContent('contracts / m1: Changed since selection');
    // The list is asked for again, so what the person confirms next is what is there now.
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/integrations/outbox').length).toBeGreaterThanOrEqual(2));
  }, 20_000);
});
