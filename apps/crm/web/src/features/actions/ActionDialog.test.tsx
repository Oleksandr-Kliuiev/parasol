import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { REVERIFY_EVENT } from '../../api/client';
import { ActionDialog } from './ActionDialog';
import type { ActionLevel, ActionPreview, ActionRequest, VendorAction } from './types';

afterEach(() => vi.unstubAllGlobals());

const request: ActionRequest = { system: 'atera', kind: 'ticket.close', targetType: 'ticket', targetId: '4711', parameters: { note: 'x' } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function preview(level: ActionLevel = 'Standard', changes: Partial<ActionPreview> = {}): ActionPreview {
  return {
    previewToken: 'signed-token', expiresAt: '2026-10-21T12:10:00Z', system: 'atera', kind: 'ticket.close', level,
    target: { type: 'ticket', id: '4711', name: '#4711 Printer is down', organizationId: 'o1', organizationName: 'Havbris AS', externalCustomerId: '17', url: 'https://atera.example/ticket/4711' },
    effects: [{ code: 'VND_EFFECT_TICKET_STATUS', values: { from: 'Open', to: 'Closed' } }], block: null,
    confirmation: { reason: level !== 'Standard', typedName: level === 'Destructive', freshSignIn: level === 'Destructive', holdSeconds: level === 'Destructive' ? 60 : 0 },
    simulated: false, paused: false, ...changes,
  };
}

function action(changes: Partial<VendorAction> = {}): VendorAction {
  return {
    id: 'a1', system: 'atera', kind: 'ticket.close', level: 'Standard', targetType: 'ticket', targetId: '4711', targetName: '#4711 Printer is down',
    organizationId: 'o1', organizationName: 'Havbris AS', parameters: {}, reason: null, status: 'Queued', outcomeCode: null, outcome: null, reference: null,
    attempts: 0, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-10-21T12:00:00Z', notBefore: '2026-10-21T12:00:00Z',
    startedAt: null, completedAt: null, closedBy: null, closedByName: null, closedAt: null, closeReason: null, etag: '"v1"', ...changes,
  };
}

function Host({ onFinished }: { onFinished?: (action: VendorAction) => void }) {
  const [open, setOpen] = useState(true);
  return <ActionDialog request={open ? request : null} title="Close ticket #4711" confirm="Close ticket" onClose={() => setOpen(false)} onFinished={onFinished} />;
}

const render = (onFinished?: (action: VendorAction) => void) =>
  renderRoutes([page(<Host onFinished={onFinished} />)], '/', testUser(['service.read', 'service.write']));

const posts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

it('shows the preview, sends one confirmed command with its token and follows the action to its outcome', async () => {
  let reads = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/actions/preview') return json(preview());
    if (url === '/api/v1/actions' && init?.method === 'POST') return json(action(), 202);
    if (url === '/api/v1/actions/a1') return json(++reads < 2 ? action({ status: 'Sending' }) : action({ status: 'Succeeded', outcomeCode: 'VND_SENT', outcome: 'Sent.' }));
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch); const finished = vi.fn(); render(finished);

  expect(await screen.findByText('#4711 Printer is down')).toBeVisible();
  expect(screen.getByText('Havbris AS · Source: Atera')).toBeVisible();
  expect(JSON.parse(posts(fetch)[0]![1].body as string)).toEqual(request);
  await userEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
  expect(await screen.findByText('Sending to Atera…')).toBeVisible();
  const command = JSON.parse(posts(fetch)[1]![1].body as string);
  expect(command).toMatchObject({ ...request, previewToken: 'signed-token', reason: null, typedName: null });
  expect(command.commandKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Done.', {}, { timeout: 6_000 })).toBeVisible();
  await waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: 'Succeeded' })));
  expect(posts(fetch)).toHaveLength(2);
}, 15_000);

it('names what blocks an action and offers no way to confirm it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(preview('Standard', { previewToken: null, block: { code: 'VND_WRITE_DISABLED', message: 'off' } }))));
  render();
  expect(await screen.findByText('Changes to this system are switched off.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Close ticket' })).toBeDisabled();
});

it('says the vendor is in test mode or paused before anything is confirmed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(preview('Standard', { simulated: true, paused: true }))));
  render();
  expect(await screen.findByText(/Atera is in test mode \(DryRun\): nothing is sent/)).toBeVisible();
  expect(screen.getByText('The connection to Atera is paused: the action waits until it is resumed.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Close ticket' })).toBeEnabled();
});

it('asks a destructive action for the typed name and a reason, sends it for a fresh sign-in and can still cancel it during the hold', async () => {
  const held = action({ level: 'Destructive', status: 'Scheduled', notBefore: new Date(Date.now() + 60_000).toISOString(), etag: '"held"' });
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/v1/actions/preview') return json(preview('Destructive'));
    if (url === '/api/v1/actions/destructive') return json(held, 202);
    if (url === '/api/v1/actions/a1/cancel') return json({ ...held, status: 'Cancelled', outcomeCode: 'VND_CANCELLED' });
    if (url === '/api/v1/actions/a1') return json(held);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch); render();
  await screen.findByText('#4711 Printer is down'); const confirm = screen.getByRole('button', { name: 'Close ticket' });
  expect(screen.getByText(/This cannot be undone\. You confirm your sign-in, and the action is sent 60 seconds after you confirm/)).toBeVisible();
  const name = screen.getByRole('textbox', { name: 'Type “#4711 Printer is down” to confirm' });
  fireEvent.change(name, { target: { value: '#4711 printer' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'The customer asked for it' } });
  expect(screen.getByText('The name does not match.')).toBeVisible(); expect(confirm).toBeDisabled();
  fireEvent.change(name, { target: { value: '  #4711   PRINTER is down ' } }); expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  expect(await screen.findByText(/^Sent in (59|60) s\. Until then you can cancel it\.$/)).toBeVisible();
  const command = JSON.parse(posts(fetch).find(([url]) => url === '/api/v1/actions/destructive')![1].body as string);
  expect(command).toMatchObject({ reason: 'The customer asked for it', typedName: '  #4711   PRINTER is down ' });
  await userEvent.click(screen.getByRole('button', { name: 'Cancel the action' }));
  expect(await screen.findByText('Cancelled before it was sent.')).toBeVisible();
  const cancel = posts(fetch).find(([url]) => url === '/api/v1/actions/a1/cancel')!;
  expect((cancel[1].headers as Record<string, string>)['If-Match']).toBe('"held"');
});

it('needs a reason of ten characters for a disruptive action', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(preview('Disruptive'))));
  render();
  await screen.findByText('#4711 Printer is down'); const confirm = screen.getByRole('button', { name: 'Close ticket' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'too short' } }); expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'The customer asked us' } }); expect(confirm).toBeEnabled();
});

it('renews an aged preview and repeats the command with the same key, so a lost answer never makes a second action', async () => {
  let previews = 0; let commands = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/v1/actions/preview') return json(preview('Standard', { previewToken: `token-${++previews}` }));
    if (url === '/api/v1/actions') return ++commands === 1
      ? json({ code: 'VND_PREVIEW_EXPIRED', detail: 'aged' }, 409)
      : json(action({ status: 'Succeeded', outcomeCode: 'VND_SENT' }), 202);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch); render();
  await screen.findByText('#4711 Printer is down');
  await userEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
  expect(await screen.findByText(/The preview was renewed/)).toBeVisible();
  await screen.findByText('#4711 Printer is down');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close ticket' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
  expect(await screen.findByText('Done.')).toBeVisible();
  const [first, second] = posts(fetch).filter(([url]) => url === '/api/v1/actions').map(([, init]) => JSON.parse(init.body as string));
  expect(first.previewToken).toBe('token-1'); expect(second.previewToken).toBe('token-2');
  expect(second.commandKey).toBe(first.commandKey);
});

it('keeps the form and explains the next step when the server asks for a fresh sign-in', async () => {
  const announced = vi.fn(); window.addEventListener(REVERIFY_EVENT, announced);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/actions/preview'
    ? json(preview('Disruptive'))
    : json({ code: 'AUTH_REVERIFY_REQUIRED' }, 403)));
  render();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Reason' }), { target: { value: 'The customer asked us' } });
  await userEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
  expect(await screen.findByText('Confirm your sign-in in the window that opened, then press “Close ticket” again.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('The customer asked us');
  expect(announced).toHaveBeenCalledTimes(1);
  window.removeEventListener(REVERIFY_EVENT, announced);
});
