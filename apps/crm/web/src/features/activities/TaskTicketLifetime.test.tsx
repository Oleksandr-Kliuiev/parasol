import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { association, json, pageOf, renderTaskTicket, task, ticket } from './taskTicketTestFixture';

afterEach(() => vi.unstubAllGlobals());
const open = async () => userEvent.click(await screen.findByRole('button', { name: `Service ticket for ${task.subject}` }));

it.each(['Change customer', 'Change employee', 'Change task', 'Drop Service'])('cancels an association read after %s and ignores its late content', async change => {
  let first = true; let signal!: AbortSignal; let finish!: (value: Response) => void;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (first) { first = false; signal = init.signal!; return new Promise<Response>(resolve => { finish = resolve; }); }
    return json(association());
  });
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByText(change)); expect(signal.aborted).toBe(true);
  await act(async () => finish(json(association(ticket))));
  expect(screen.queryByText(`#701 · ${ticket.title}`)).not.toBeInTheDocument();
  if (change === 'Drop Service') expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  else expect(await screen.findByText('No Service ticket is linked to this task.')).toBeVisible();
});

it('cancels a picker continuation when its dialog closes and does not retain loaded rows on reopen', async () => {
  let signal!: AbortSignal; let finish!: (value: Response) => void; let firstPage = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/ticket?')) return json(association());
    if (url.includes('cursor=')) { signal = init.signal!; return new Promise<Response>(resolve => { finish = resolve; }); }
    firstPage++; return pageOf([ticket], 'next', 2);
  });
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' }));
  await screen.findByRole('radio', { name: /#701/ }); await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(finish).toBeDefined()); await userEvent.click(screen.getByRole('button', { name: 'Close' })); expect(signal.aborted).toBe(true);
  await act(async () => finish(pageOf([{ ...ticket, id: 'old-ticket', title: 'Synthetic late picker ticket' }])));
  await open(); await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' })); await screen.findByRole('radio', { name: /#701/ });
  expect(firstPage).toBe(2); expect(screen.queryByText('Synthetic late picker ticket')).not.toBeInTheDocument();
});

it.each(['Change customer', 'Change employee', 'Change task', 'Drop write and time'])('does not refresh or close a replacement picker after a late PUT and %s', async change => {
  let finish!: (value: Response) => void; let readingNew = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'PUT'
    ? new Promise<Response>(resolve => { finish = resolve; }) : url.includes('/ticket?') ? json(readingNew ? association() : association(ticket)) : pageOf());
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await open(); await userEvent.click(await screen.findByRole('button', { name: 'Unlink ticket' }));
  readingNew = true; fireEvent.click(screen.getByText(change)); await screen.findByText('No Service ticket is linked to this task.');
  if (change !== 'Drop write and time') {
    await userEvent.click(screen.getByRole('button', { name: 'Choose saved ticket' })); await screen.findByRole('radio', { name: /#701/ });
  }
  const reads = fetch.mock.calls.filter(([, init]) => init.method === 'GET').length;
  await act(async () => finish(json(association())));
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(reads);
  expect(screen.getByText('No Service ticket is linked to this task.')).toBeVisible();
  if (change !== 'Drop write and time') expect(screen.getByRole('radio', { name: /#701/ })).toBeEnabled();
});

it('returns keyboard focus to the task action after closing its dialog', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(association()))); renderTaskTicket();
  const trigger = screen.getByRole('button', { name: `Service ticket for ${task.subject}` }); trigger.focus(); await userEvent.keyboard('{Enter}');
  await screen.findByRole('dialog'); await userEvent.keyboard('{Escape}'); await waitFor(() => expect(trigger).toHaveFocus());
});
