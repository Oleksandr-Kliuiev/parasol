import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { ActionDetailDialog } from './ActionDetailDialog';
import type { VendorAction } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const action = (changes: Partial<VendorAction> = {}): VendorAction => ({
  id: 'a1', system: 'atera', kind: 'ticket.reply', level: 'Standard', targetType: 'ticket', targetId: '4711', targetName: '#4711 Printer is down',
  organizationId: 'o1', organizationName: 'Havbris AS', parameters: { text: 'On my way' }, reason: null, status: 'Uncertain', outcomeCode: 'VND_NO_ANSWER',
  outcome: 'No answer.', reference: null, attempts: 1, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-10-21T12:00:00Z',
  notBefore: '2026-10-21T12:00:00Z', startedAt: '2026-10-21T12:00:01Z', completedAt: '2026-10-21T12:00:05Z', closedBy: null, closedByName: null,
  closedAt: null, closeReason: null, ticketId: 't1', vendorUrl: 'https://atera.example/ticket/4711', etag: '"v1"', ...changes,
});

const render = (shown: VendorAction, options: { ticketShown?: boolean; permissions?: string[] } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === `/api/v1/actions/${shown.id}` ? json(shown) : json({}, 404))));
  return renderRoutes([page(<ActionDetailDialog action={shown} onClose={() => undefined} ticketShown={options.ticketShown} />)], '/connections',
    testUser(options.permissions ?? ['service.read', 'service.write', 'integrations.manage']));
};

it('leads from an action without a clear answer to its ticket at Atera and in Parasoll, beside the verdict', async () => {
  render(action());
  expect(await screen.findByRole('link', { name: 'Check in Atera' })).toHaveAttribute('href', 'https://atera.example/ticket/4711');
  expect(screen.getByRole('link', { name: 'Open the ticket' })).toHaveAttribute('href', '/tickets?ticket=t1');
  expect(screen.getByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save what you found' })).toBeDisabled();
  // The card opens on its way out, not on the link that leaves for Atera.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
});

it('says Open in Atera for an action with an outcome, and offers no way to a ticket it does not know', async () => {
  render(action({ status: 'Succeeded', outcomeCode: 'VND_SENT', ticketId: null }));
  expect(await screen.findByRole('link', { name: 'Open in Atera' })).toHaveAttribute('href', 'https://atera.example/ticket/4711');
  expect(screen.queryByRole('link', { name: 'Open the ticket' })).not.toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
});

it('offers no way to the ticket over the ticket itself, nor to someone who cannot read tickets', async () => {
  const shown = render(action(), { ticketShown: true });
  expect(await screen.findByRole('link', { name: 'Check in Atera' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Open the ticket' })).not.toBeInTheDocument();
  shown.unmount();

  render(action({ kind: 'time.record', targetType: 'time-entry', targetId: 'e1' }), { permissions: ['time.own'] });
  expect(await screen.findByRole('link', { name: 'Check in Atera' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Open the ticket' })).not.toBeInTheDocument();
});

it('leaves an address that is not a web link out', async () => {
  render(action({ vendorUrl: 'javascript:alert(1)', ticketId: null }));
  expect(await screen.findByRole('radiogroup', { name: /Did it happen\?/ })).toBeVisible();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
