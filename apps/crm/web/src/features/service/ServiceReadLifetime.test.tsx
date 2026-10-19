import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueryClient } from '@tanstack/react-query';
import { allowed, answer, device, json, kindOf, kinds, names, pageResult, refreshName, renderService } from './serviceReadTestFixture';

afterEach(() => vi.unstubAllGlobals());

it('performs no saved reads without service.read and offers no create control to a read-only employee', async () => {
  const fetch = vi.fn(async (url: string) => answer(kindOf(url)!)); vi.stubGlobal('fetch', fetch); const view = renderService(['service.write']);
  expect(screen.queryByRole('region', { name: 'Saved service data' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled(); view.unmount();
  renderService(['service.read']); await screen.findByText('Synthetic PC one');
  expect(screen.queryByRole('button', { name: 'New ticket' })).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(5);
});

it.each(['Change employee', 'Drop write', 'Change customer', 'Drop read'])('aborts all old saved reads and refuses late content after %s', async change => {
  const old: { signal: AbortSignal; finish: (value: Response) => void; kind: typeof kinds[number] }[] = []; let changed = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (!changed) return new Promise<Response>(resolve => { old.push({ signal: init.signal!, finish: resolve, kind: kindOf(url)! }); });
    return kindOf(url) === 'devices' ? pageResult([device('new-owner')]) : answer(kindOf(url)!, false);
  });
  vi.stubGlobal('fetch', fetch); renderService(); await waitFor(() => expect(old).toHaveLength(5)); changed = true;
  await userEvent.click(screen.getByRole('button', { name: change })); expect(old.every(read => read.signal.aborted)).toBe(true);
  if (change !== 'Drop read') expect(await screen.findByText('Synthetic PC new-owner')).toBeVisible();
  await act(async () => old.forEach(read => read.finish(answer(read.kind))));
  expect(screen.queryByText('Synthetic PC one')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic ticket one')).not.toBeInTheDocument();
  expect(screen.queryByText(/Synthetic request one/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(change === 'Drop read' ? 5 : 10);
});

it('clears previously successful data before a new employee read and removes unused old-owner queries from cache', async () => {
  let held = false; let client!: QueryClient; const replies: (() => void)[] = [];
  const fetch = vi.fn(async (url: string) => held ? new Promise<Response>(resolve => { replies.push(() => resolve(answer(kindOf(url)!, false))); }) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(allowed, value => { client = value; }); await screen.findByText('Synthetic PC one');
  const oldKeys = client.getQueryCache().findAll({ queryKey: ['service'] }).map(query => query.queryHash); expect(oldKeys).toHaveLength(5);
  held = true; await userEvent.click(screen.getByRole('button', { name: 'Change employee' }));
  expect(screen.queryByText('Synthetic PC one')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic ticket one')).not.toBeInTheDocument();
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['service'] }).every(query => !oldKeys.includes(query.queryHash))).toBe(true));
  await act(async () => replies.forEach(finish => finish())); await screen.findByText('No open tickets.'); expect(fetch).toHaveBeenCalledTimes(10);
});

it('hides previous rows on a failed global refresh instead of presenting stale data as current', async () => {
  let failed = false; const fetch = vi.fn(async (url: string) => failed ? json({}, 503) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await screen.findByText('Synthetic PC one'); failed = true;
  await userEvent.click(screen.getByRole('button', { name: refreshName }));
  for (const kind of kinds) expect(await within(screen.getByRole('region', { name: names[kind] })).findByText(/Saved data could not be read/)).toBeVisible();
  expect(screen.queryByText('Synthetic PC one')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic ticket one')).not.toBeInTheDocument();
  expect(screen.queryByText(/^No /)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(10);
  fireEvent(window, new Event('focus')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(10);
});
