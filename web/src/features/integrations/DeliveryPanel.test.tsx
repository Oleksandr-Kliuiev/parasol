import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, screen, waitFor, within } from '@testing-library/react';
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
    message('m2', { module: 'billing', eventType: 'QuoteAccepted', deliveredHandlers: ['QuoteAcceptedChargeHandler'] }),
    message('m3', { status: 'Quarantined', eventType: 'ProjectPhaseBillable', replayRequested: true, attempts: 1 }),
  ],
};

function stubFetch(replay: (body: unknown) => Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/v1/integrations/outbox/replay') return replay(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(overview), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The open dialog, found by its title: a role query over the whole page is too slow for jsdom on a loaded machine. */
async function openedDialog(title: string) {
  const heading = await screen.findByText(title, undefined, { timeout: 5_000 });
  return heading.closest<HTMLElement>('[role="dialog"]')!;
}

function render() {
  renderRoutes(
    [{ path: '/admin', element: <><Toaster toasterId={TOASTER_ID} /><DeliveryPanel /></> }],
    '/admin',
    testUser(['integrations.manage']),
  );
}

// Fluent's modal handling (Tabster) sets aria-hidden outside the active dialog on a timer; in jsdom it sometimes hides the
// open dialog itself, which real browsers never do (see BillingRunsPage.test). Role queries therefore include hidden nodes;
// accessibility is checked in the browser (web/e2e/a11y.spec.ts).
configure({ defaultHidden: true });

afterEach(() => vi.unstubAllGlobals());

describe('DeliveryPanel', () => {
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
        { module: 'contracts', id: 'm1' },
        { module: 'billing', id: 'm2' },
      ],
      reason: 'short — timeout in PowerOffice fixed',
      expected: 2,
    });
    expect(await screen.findByText('Replay of 2 messages requested; crm-worker delivers them within seconds.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }, 20_000);

  it('keeps the dialog open with the reason when the list changed before the confirmation', async () => {
    const fetch = stubFetch(
      () =>
        new Response(JSON.stringify({ status: 409, title: 'OUTBOX_REPLAY_STALE', code: 'OUTBOX_REPLAY_STALE' }), {
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
    // The list is asked for again, so what the person confirms next is what is there now.
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/integrations/outbox').length).toBeGreaterThanOrEqual(2));
  }, 20_000);
});
