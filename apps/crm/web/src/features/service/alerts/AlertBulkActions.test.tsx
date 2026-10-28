import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, syntheticAlert } from '../../../test/alerts';
import { formatDate } from '../../../shared/utils/format';
import { dayIn } from './alertHiding';
import { AlertQueuePage } from './AlertQueuePage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const writer = ['customers.read', 'service.read', 'service.write', 'activities.read', 'activities.write'];
const disk = syntheticAlert({ id: 'a1', externalId: '920029', title: 'Disk almost full on SRV-01' });
const toner = syntheticAlert({ id: 'a2', externalId: '920030', severity: 'Warning', title: 'OID Toner below threshold', organizationName: 'Vik Regnskap AS',
  deviceName: 'PRN-01', createdAt: '2026-06-20T06:00:00Z' });
const gap = syntheticAlert({ id: 'a3', system: 'parasoll', externalId: 'atera.agent-silent:d1', severity: 'Warning', title: 'Agent silent', deviceName: null });
const item = (alert: typeof disk, overrides: Record<string, unknown> = {}) => ({
  id: alert.id, system: alert.system, externalId: alert.externalId, title: alert.title, deviceName: alert.deviceName, organizationId: alert.organizationId,
  organizationName: alert.organizationName, severity: alert.severity, state: alert.state, createdAt: alert.createdAt, hiddenUntil: null, rule: null, facts: null,
  sourceClosedAt: null, etag: `"etag-${alert.id}"`, ...overrides,
});
const kinds = [{ system: 'atera', kind: 'alert.resolve', targetType: 'alert', level: 'Standard', simulated: false, limitedToCustomers: false, batch: true }];
// The boxes are named by their alerts with what tells them from a namesake: the device and the customer.
const boxOf = { disk: 'Select Disk almost full on SRV-01 (SRV-01, Fjord IT AS)', toner: 'Select OID Toner below threshold (PRN-01, Vik Regnskap AS)',
  gap: 'Select Agent silent (Fjord IT AS)' };
const idle = 'Select alerts to act on several at once.';

type Answer = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
function stub(answer: Answer = () => undefined) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://parasoll.invalid');
    return answer(url, init) ?? served(url);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function served(url: URL) {
  if (url.pathname === '/api/v1/service/alerts') return json(alertPage([disk, toner, gap], 'next', 30));
  if (url.pathname === '/api/v1/activities/source-tasks/lookup') return json({ items: [] });
  if (url.pathname === '/api/v1/actions/kinds') return json(kinds);
  return json({}, 404);
}
const bodiesOf = (fetch: ReturnType<typeof stub>, path: string) => fetch.mock.calls
  .filter(([url]) => new URL(String(url), 'https://parasoll.invalid').pathname === path).map(([, init]) => JSON.parse(String(init!.body)));
const bodyOf = (fetch: ReturnType<typeof stub>, path: string) => bodiesOf(fetch, path)[0];
const render = (path = '/alerts', permissions = writer) => renderRoutes([page(<AlertQueuePage />, '/alerts')], path, testUser(permissions));
const bar = () => screen.getByRole('region', { name: 'Selected alerts' });

afterEach(() => vi.unstubAllGlobals());

describe('alert queue: source and age (M45)', () => {
  it('narrows by source and age in the address and the request, one age at a time, and clears them with the other filters', async () => {
    const fetch = stub();
    const { router } = render();
    await screen.findByRole('table', { name: 'Alerts' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Source' }));
    await userEvent.click(screen.getByRole('option', { name: 'Atera' }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=atera'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Age' }));
    // What is new, then what is old.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      ['Any age', 'Last 24 hours', 'Last 7 days', 'Older than 7 days', 'Older than 30 days', 'Older than 90 days', 'Older than a year']);
    await userEvent.click(screen.getByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=atera&newerThan=1'));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts?system=atera&newerThanDays=1&limit=25'));
    // An old age replaces the new one: the queue never asks for both.
    await userEvent.click(screen.getByRole('combobox', { name: 'Age' }));
    await userEvent.click(screen.getByRole('option', { name: 'Older than 90 days' }));
    await waitFor(() => expect(router.state.location.search).toBe('?source=atera&olderThan=90'));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts?system=atera&olderThanDays=90&limit=25'));

    stub((url) => url.pathname === '/api/v1/service/alerts' ? json(alertPage([])) : undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh alerts' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  }, 15_000);

  it('offers an age the address names beside the usual ones', async () => {
    stub(); render('/alerts?olderThan=45');
    await screen.findByRole('table', { name: 'Alerts' });
    expect(screen.getByRole('combobox', { name: 'Age' })).toHaveTextContent('Older than 45 days');
  });

  it('offers a new age the address names, and reads it as the queue asks for it', async () => {
    const fetch = stub(); render('/alerts?newerThan=3');
    await screen.findByRole('table', { name: 'Alerts' });
    expect(screen.getByRole('combobox', { name: 'Age' })).toHaveTextContent('Last 3 days');
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts?newerThanDays=3&limit=25'));
  });

  it('reads an address that names both ages by the old one, as the age filter shows it', async () => {
    const fetch = stub(); render('/alerts?olderThan=45&newerThan=1');
    await screen.findByRole('table', { name: 'Alerts' });
    expect(screen.getByRole('combobox', { name: 'Age' })).toHaveTextContent('Older than 45 days');
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts?olderThanDays=45&limit=25'));
    expect(fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('newerThanDays'))).toEqual([]);
  });
});

describe('alert queue: choosing alerts (M45)', () => {
  it('offers no choice to a reader who may not act on alerts, nor in the resolved list', async () => {
    stub(); render('/alerts', ['customers.read', 'service.read']);
    await screen.findByRole('table', { name: 'Alerts' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected alerts' })).not.toBeInTheDocument();

    stub(); render('/alerts?state=resolved');
    expect(await screen.findAllByRole('table', { name: 'Alerts' })).not.toHaveLength(0);
    expect(screen.queryAllByRole('checkbox', { name: /^Select/ }).filter((box) => !box.closest('[aria-hidden]'))).toHaveLength(0);
  }, 15_000);

  it('keeps its bar in place, chooses rows, then all that match, says how many, and starts over when the filters change', async () => {
    const fetch = stub((url) => url.pathname === '/api/v1/service/alerts/selection'
      ? json({ items: [item(disk), item(toner), item(gap)], totalCount: 3, limit: 500 }) : undefined);
    render();
    // The bar is there before anything is chosen, so ticking the first box moves no row under the pointer.
    await screen.findByRole('table', { name: 'Alerts' });
    expect(within(bar()).getByRole('status')).toHaveTextContent(idle);
    const firstRow = screen.getByRole('checkbox', { name: boxOf.disk }).closest('tr')!;
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.disk }));
    expect(screen.getByRole('checkbox', { name: boxOf.disk }).closest('tr')).toBe(firstRow);
    expect(within(bar()).getByRole('status')).toHaveTextContent('1 selected');
    expect(within(bar()).getByRole('button', { name: 'Close in Atera (1)' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Hide until… (1)' })).toBeVisible();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all alerts shown' }));
    expect(within(bar()).getByRole('status')).toHaveTextContent('3 selected');
    // A gap Parasoll found has no source to close it at: only the Atera alerts are counted for Atera.
    expect(within(bar()).getByRole('button', { name: 'Close in Atera (2)' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Hide until… (3)' })).toBeVisible();

    await userEvent.click(within(bar()).getByRole('button', { name: 'Select all 30 that match the filters' }));
    expect(await within(bar()).findByText('All 3 that match the filters are selected')).toBeVisible();
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts/selection');
    // The link that asked is gone: focus goes on to the first thing to do with them, not to the page.
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Close in Atera (2)' })).toHaveFocus());

    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.disk }));
    expect(within(bar()).getByRole('status')).toHaveTextContent('2 selected');
    await userEvent.click(screen.getByRole('button', { name: /^Warning/ }));
    await waitFor(() => expect(within(bar()).getByRole('status')).toHaveTextContent(idle));
  }, 15_000);

  it('keeps a choice made while all that match is read, and offers no action for more than one bulk action takes', async () => {
    const answers: Array<(response: Response) => void> = [];
    const many = Array.from({ length: 500 }, (_, i) => item(syntheticAlert({ id: `m${i}`, externalId: `8${i}`, title: `Alert ${i}` })));
    stub((url) => url.pathname === '/api/v1/service/alerts' ? json(alertPage([disk, toner], 'next', 612))
      : url.pathname === '/api/v1/service/alerts/selection' ? new Promise<Response>((resolve) => { answers.push(resolve); }) : undefined);
    render();
    await screen.findByRole('table', { name: 'Alerts' });
    // A box ticked while the answer is on its way wins over it.
    await userEvent.click(within(bar()).getByRole('button', { name: 'Select the first 500 of 612 that match the filters' }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.disk }));
    await act(async () => { answers[0]!(json({ items: many, totalCount: 612, limit: 500 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(within(bar()).getByRole('status')).toHaveTextContent('1 selected');

    // All that one bulk action takes, and one more ticked beside them: no action is offered, only what to do instead.
    await userEvent.click(within(bar()).getByRole('button', { name: 'Clear selection' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Select the first 500 of 612 that match the filters' }));
    await act(async () => { answers[1]!(json({ items: many, totalCount: 612, limit: 500 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(await within(bar()).findByText('The first 500 of 612 that match the filters are selected; one bulk action takes at most 500.')).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.toner }));
    expect(within(bar()).getByRole('status')).toHaveTextContent('501 selected; one bulk action takes at most 500, so untick some to go on.');
    expect(within(bar()).queryByRole('button', { name: /^(Hide until|Close in Atera)/ })).not.toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Clear selection' })).toBeVisible();
  }, 15_000);

  it('offers all that match before anything is chosen, and says when they are more than one bulk action takes', async () => {
    stub((url) => url.pathname === '/api/v1/service/alerts' ? json(alertPage([disk, toner], 'next', 612))
      : url.pathname === '/api/v1/service/alerts/selection' ? json({ items: [item(disk), item(toner)], totalCount: 612, limit: 500 }) : undefined);
    render();
    await screen.findByRole('table', { name: 'Alerts' });
    await userEvent.click(within(bar()).getByRole('button', { name: 'Select the first 500 of 612 that match the filters' }));
    expect(await within(bar()).findByText('The first 2 of 612 that match the filters are selected; one bulk action takes at most 2.')).toBeVisible();
  });
});

describe('alert queue: hiding many (M45)', () => {
  it('reads the chosen alerts, hides those it can until one day with one reason, and says which stayed as they were', async () => {
    const fetch = stub((url, init) => {
      if (url.pathname === '/api/v1/service/alerts/lookup') {
        return json({ items: [item(disk), item(toner, { state: 'Resolved' })], totalCount: 2, limit: 500 });
      }
      if (url.pathname === '/api/v1/service/alerts/hide' && init?.method === 'POST') {
        return json({ items: [{ id: 'a1', outcome: 'Changed' }], applied: 0 });
      }
      return undefined;
    });
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.toner }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide until… (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide 2 alerts until a date' });
    expect(await within(dialog).findByText('Parasoll hides 1 alert until the day you choose.')).toBeVisible();
    expect(within(dialog).getByText('1 – No longer open in their source.')).toBeVisible();
    // Only what applies to the chosen alerts: an Atera alert stays open there; nothing about gaps, as none is chosen.
    expect(within(dialog).getByText('Their sources cannot snooze alerts through their APIs, so they stay open there.')).toBeVisible();
    expect(within(dialog).queryByText(/coverage gap/)).not.toBeInTheDocument();
    expect(bodyOf(fetch, '/api/v1/service/alerts/lookup')).toEqual({ ids: ['a1', 'a2'] });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide 1' }));
    expect(within(dialog).getByText('Say why the alerts are hidden.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'In a week' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Printers are replaced next month');
    expect(within(dialog).getByText(`Hidden for everyone until ${formatDate(dayIn(7))}; it comes back by itself.`)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide 1' }));

    expect(bodyOf(fetch, '/api/v1/service/alerts/hide')).toEqual({
      alerts: [{ id: 'a1', etag: '"etag-a1"' }], until: dayIn(7), reason: 'Printers are replaced next month',
    });
    expect(await within(dialog).findByText('0 alerts hidden until ' + formatDate(dayIn(7)) + '.')).toBeVisible();
    const left = within(dialog).getByRole('list', { name: '1 stays as it is:' });
    expect(within(left).getByText('Disk almost full on SRV-01')).toBeVisible();
    expect(within(left).getByText(/Someone changed it while you looked, so it stays as it is\./)).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Nothing changed: the choice stays for the next try, and there is nothing to undo.
    expect(await within(await screen.findByRole('region', { name: 'Selected alerts' })).findByText('2 selected')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  }, 15_000);

  it('closes when every chosen alert was hidden, gives focus to the list and offers the way back above it', async () => {
    let hidden = false;
    const fetch = stub((url, init) => {
      if (url.pathname === '/api/v1/service/alerts/lookup') {
        const until = hidden ? `${dayIn(1)}T00:00:00+01:00` : null;
        return json({ items: [item(disk, { hiddenUntil: until }), item(toner, { hiddenUntil: until })], totalCount: 2, limit: 500 });
      }
      if (url.pathname === '/api/v1/service/alerts/hide' && init?.method === 'POST') {
        hidden = true;
        return json({ items: [{ id: 'a1', outcome: 'Hidden', etag: '"hidden-a1"' }, { id: 'a2', outcome: 'Hidden', etag: '"hidden-a2"' }], applied: 2 });
      }
      if (url.pathname === '/api/v1/service/alerts/show' && init?.method === 'POST') {
        hidden = false;
        return json({ items: [{ id: 'a1', outcome: 'Shown', etag: '"shown-a1"' }, { id: 'a2', outcome: 'Changed', etag: null }], applied: 1 });
      }
      return undefined;
    });
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.toner }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide until… (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide 2 alerts until a date' });
    await userEvent.type(await within(dialog).findByRole('textbox', { name: /Reason/ }), 'Printers are replaced next month');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide 2' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf(fetch, '/api/v1/service/alerts/hide')).toMatchObject({ until: dayIn(1), reason: 'Printers are replaced next month' });
    expect(await screen.findByText(`2 alerts hidden until ${formatDate(dayIn(1))}.`)).toBeVisible();
    await waitFor(() => expect(within(bar()).getByRole('status')).toHaveTextContent(idle));
    await waitFor(() => expect(document.querySelector('[data-alert-list]')).toHaveFocus());

    // The way back has no time limit: each alert is shown again as the hide left it, so one someone changed since stays as it is.
    const reads = bodiesOf(fetch, '/api/v1/service/alerts/lookup').length;
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const undone = '1 alert is shown again. 1 was changed since and stays as it is.';
    expect(await screen.findByText(undone)).toBeVisible();
    expect(bodiesOf(fetch, '/api/v1/service/alerts/lookup')).toHaveLength(reads);
    expect(bodyOf(fetch, '/api/v1/service/alerts/show')).toEqual({ alerts: [{ id: 'a1', etag: '"hidden-a1"' }, { id: 'a2', etag: '"hidden-a2"' }] });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(undone)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-alert-list]')).toHaveFocus());
  }, 15_000);
});

describe('alert queue: the way back after a partial hide (M45)', () => {
  it('offers it whichever way the result is closed', async () => {
    stub((url, init) => {
      if (url.pathname === '/api/v1/service/alerts/lookup') return json({ items: [item(disk), item(toner)], totalCount: 2, limit: 500 });
      if (url.pathname === '/api/v1/service/alerts/hide' && init?.method === 'POST') {
        return json({ items: [{ id: 'a1', outcome: 'Hidden', etag: '"hidden-a1"' }, { id: 'a2', outcome: 'Changed', etag: null }], applied: 1 });
      }
      return undefined;
    });
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.toner }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide until… (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide 2 alerts until a date' });
    await userEvent.type(await within(dialog).findByRole('textbox', { name: /Reason/ }), 'Printers are replaced next month');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide 2' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(`1 alert hidden until ${formatDate(dayIn(1))}.`)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  }, 15_000);
});

describe('alert queue: closing many in Atera (M45)', () => {
  const preview = {
    previewToken: 'token', expiresAt: '2026-10-28T10:00:00Z', system: 'atera', kind: 'alert.resolve', level: 'Standard', ready: 1, block: null,
    confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
    targets: [
      { targetId: '920029', target: { type: 'alert', id: '920029', name: disk.title, organizationId: 'o1', organizationName: 'Fjord IT AS',
        externalCustomerId: '7', url: null }, block: null, waitingActionId: null },
      { targetId: '920030', target: { type: 'alert', id: '920030', name: toner.title, organizationId: 'o2', organizationName: 'Vik Regnskap AS',
        externalCustomerId: '8', url: null }, block: { code: 'VND_ALERT_RESOLVED', message: 'The alert is no longer open in Atera.' }, waitingActionId: null },
    ],
  };
  const batchState = (waiting: number, items: unknown[] = []) => ({ id: 'b1', system: 'atera', kind: 'alert.resolve', total: 1, waiting,
    succeeded: 1 - waiting, skipped: 0, simulated: 0, failed: 0, uncertain: 0, items });
  const done = { actionId: 'act1', targetId: '920029', targetName: disk.title, organizationId: 'o1', organizationName: 'Fjord IT AS', status: 'Succeeded',
    outcomeCode: 'VND_SENT', completedAt: '2026-10-28T09:00:00Z' };

  it('previews the batch, confirms it once and follows it to a result per alert', async () => {
    const fetch = stub((url, init) => {
      if (url.pathname === '/api/v1/actions/batch/preview') return json(preview);
      if (url.pathname === '/api/v1/actions/batch' && init?.method === 'POST') {
        return json({ batchId: 'b1', items: [{ targetId: '920029', actionId: 'act1', status: 'Queued', code: null }], asked: 1, repeated: false }, 202);
      }
      if (url.pathname === '/api/v1/actions/batches/b1') return json(batchState(0, url.searchParams.get('items') === 'true' ? [done] : []));
      return undefined;
    });
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.toner }));
    await userEvent.click(screen.getByRole('checkbox', { name: boxOf.gap }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close in Atera (2)' }));

    const dialog = await screen.findByRole('dialog', { name: 'Close alerts in Atera' });
    expect(await within(dialog).findByText(
      'Atera closes this alert. Parasoll resolves it once a read of Atera confirms that it is closed. It is critical.')).toBeVisible();
    expect(within(dialog).getByRole('heading', { name: '2 stay as they are:' })).toBeVisible();
    expect(within(dialog).getByText('1 – The alert is no longer open in Atera.')).toBeVisible();
    expect(within(dialog).getByText('1 – Not from Atera.')).toBeVisible();
    // Each alert to close with what tells it apart: severity, customer, device and age.
    const closing = within(dialog).getByRole('list', { name: 'To close in Atera (1)' });
    expect(within(closing).getByText('Critical')).toBeVisible();
    expect(within(closing).getByText(/Fjord IT AS · SRV-01 ·/)).toBeVisible();
    expect(bodyOf(fetch, '/api/v1/actions/batch/preview')).toEqual({
      system: 'atera', kind: 'alert.resolve', targetType: 'alert', targetIds: ['920029', '920030'], parameters: {},
    });
    // Nothing to type: the way out has the focus, so a stray Enter changes nothing.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close 1 in Atera' }));
    const command = bodyOf(fetch, '/api/v1/actions/batch');
    expect(command).toMatchObject({ targetIds: ['920029'], previewToken: 'token', system: 'atera', kind: 'alert.resolve' });
    expect(command.batchKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await within(dialog).findByText('Handled.')).toBeVisible();
    const results = await within(dialog).findByRole('list', { name: 'Result for 1 alert' });
    expect(within(results).getByText('Done')).toBeVisible();
    expect(within(results).getByText('Fjord IT AS · Closed in Atera.')).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(bar()).getByRole('status')).toHaveTextContent(idle));
    expect(await screen.findByText('Closing in Atera is done: 1 alert handled.')).toBeVisible();
  }, 15_000);

  it('follows a batch closed early above the list and opens its dialog on it again', async () => {
    let waiting = 1;
    stub((url, init) => {
      if (url.pathname === '/api/v1/actions/batch/preview') return json(preview);
      if (url.pathname === '/api/v1/actions/batch' && init?.method === 'POST') {
        return json({ batchId: 'b1', items: [{ targetId: '920029', actionId: 'act1', status: 'Queued', code: null }], asked: 1, repeated: false }, 202);
      }
      if (url.pathname === '/api/v1/actions/batches/b1') return json(batchState(waiting, url.searchParams.get('items') === 'true' ? [done] : []));
      return undefined;
    });
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close in Atera (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close alerts in Atera' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close 1 in Atera' }));
    expect(await within(dialog).findByText('0 of 1 handled')).toBeVisible();
    expect(within(dialog).getByRole('progressbar', { name: 'Handled so far' })).toBeVisible();

    // Escape closes it as Close does: the actions were asked, so the selection ends and focus goes to the list.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(bar()).getByRole('status')).toHaveTextContent(idle));
    await waitFor(() => expect(document.querySelector('[data-alert-list]')).toHaveFocus());
    expect(await screen.findByText('Closing in Atera: 0 of 1 handled.')).toBeVisible();

    waiting = 0;
    expect(await screen.findByText('Closing in Atera is done: 1 alert handled.', undefined, { timeout: 6_000 })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Show the result' }));
    const again = await screen.findByRole('dialog', { name: 'Close alerts in Atera' });
    expect(await within(within(again).getByRole('list', { name: 'Result for 1 alert' })).findByText('Fjord IT AS · Closed in Atera.')).toBeVisible();
  }, 15_000);

  it('does not offer to close in Atera when the kind cannot be asked for in bulk', async () => {
    stub((url) => url.pathname === '/api/v1/actions/kinds' ? json([{ ...kinds[0], batch: false }]) : undefined);
    render();
    await userEvent.click(await screen.findByRole('checkbox', { name: boxOf.disk }));
    expect(within(bar()).getByRole('button', { name: 'Hide until… (1)' })).toBeVisible();
    expect(within(bar()).queryByRole('button', { name: /Close in Atera/ })).not.toBeInTheDocument();
  });
});
