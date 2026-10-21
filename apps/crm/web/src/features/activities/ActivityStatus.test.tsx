import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { activityUrl } from './activityNavigation';
import { auxiliary, first, isActivityRead, organizationId, renderSelection, response, result, second, selectedPath } from './activityNavigationTestFixture';
import type { Activity } from './types';

afterEach(() => vi.unstubAllGlobals());
const complete = (activity = first) => screen.getByRole('button', { name: `Mark ${activity.subject} as done` });
const reopen = (activity = first) => screen.getByRole('button', { name: `Reopen ${activity.subject}` });
const writes = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST');
const reads = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => isActivityRead(url as string));
const timelinePath = `/organizations/${organizationId}?tab=activities`;

it.each(['Task', 'Call', 'Meeting'] as const)('reopens a Done %s with its displayed ETag', async type => {
  const done = { ...first, type, status: 'Done' as const, etag: '"done-version"' };
  const fetch = vi.fn(async (url: string, init: RequestInit) => auxiliary(url) ?? (init.method === 'POST' ? response(done) : result([done])));
  vi.stubGlobal('fetch', fetch); renderSelection(selectedPath(), ['activities.read', 'activities.write']); await screen.findByText(first.subject);
  await userEvent.click(reopen()); await waitFor(() => expect(writes(fetch)).toHaveLength(1));
  expect(writes(fetch)[0]).toEqual([`/api/v1/activities/${first.id}/reopen`, expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'If-Match': done.etag }), body: undefined })]);
});

it.each([
  { type: 'Note', status: 'Done' }, { type: 'Email', status: 'Done' }, { type: 'Task', status: 'Cancelled' },
] as const)('does not offer Reopen for $status $type', async overrides => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => auxiliary(url) ?? result([{ ...first, ...overrides }]))); renderSelection();
  await screen.findByText(first.subject); expect(screen.queryByRole('button', { name: /^Reopen / })).not.toBeInTheDocument();
});

it('keeps existing Open Note completion and offers no status actions to read-only employees', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => auxiliary(url) ?? result([{ ...first, type: 'Note' }])));
  const view = renderSelection(); await screen.findByText(first.subject); expect(complete()).toBeVisible(); view.unmount();
  renderSelection(selectedPath(), ['activities.read']); await screen.findByText(first.subject);
  expect(screen.queryByRole('button', { name: /^Mark .* as done$/ })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /^Reopen / })).not.toBeInTheDocument();
});

it('locks only the pending Meeting, refuses duplicate activation and disables its edit and calendar controls', async () => {
  const meeting: Activity = { ...first, type: 'Meeting' }; let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/outlook/status')) return response({ calendar: true, mail: false });
    if (init.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    return auxiliary(url) ?? result([meeting, second]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(timelinePath); await screen.findByText(first.subject);
  complete().focus(); await userEvent.keyboard('{Enter}');
  for (const button of [complete(), screen.getByRole('button', { name: `Edit ${first.subject}` }), screen.getByRole('button', { name: `Add ${first.subject} to the calendar` })]) {
    expect(button).toHaveAttribute('aria-disabled', 'true'); expect(button).not.toHaveAttribute('disabled');
  }
  expect(complete(second)).not.toHaveAttribute('aria-disabled', 'true');
  await userEvent.keyboard('{Enter} '); fireEvent.click(complete()); expect(writes(fetch)).toHaveLength(1);
  expect(writes(fetch)[0]![1].headers).toMatchObject({ 'If-Match': first.etag });
  await act(async () => finish(response({}, 412))); expect(await screen.findByRole('alert')).toHaveTextContent('displayed version');
});

it.each(['selected', 'ordinary'])('keeps the %s displayed row on 412 with no retry or reread and an exact review path', async kind => {
  const original = { ...first, body: 'Synthetic preserved body', dueAt: '2025-10-26T02:30:12.345+01:00' };
  const fetch = vi.fn(async (url: string, init: RequestInit) => auxiliary(url) ?? (init.method === 'POST' ? response({ code: 'CONCURRENCY_CONFLICT' }, 412) : result([original])));
  vi.stubGlobal('fetch', fetch); renderSelection(kind === 'selected' ? selectedPath() : timelinePath); await screen.findByText(first.subject);
  await userEvent.click(complete()); const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Refresh or review the current record before trying again.');
  expect(screen.getByRole('link', { name: 'Review current activity' })).toHaveAttribute('href', activityUrl(first.organizationId, first.id));
  expect(screen.getByText(original.body)).toBeVisible(); expect(screen.getByText(/Kari Nordmann/)).toBeVisible();
  expect(complete()).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(complete()); fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online'));
  expect(writes(fetch)).toHaveLength(1); expect(reads(fetch)).toHaveLength(1);
});

it('uses the refreshed version for a new command after a conflict and retains status keyboard focus through complete and reopen', async () => {
  let current = first; let fail = true;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      if (fail) return response({ code: 'CONCURRENCY_CONFLICT' }, 412);
      current = { ...current, status: url.endsWith('/complete') ? 'Done' : 'Open', etag: url.endsWith('/complete') ? '"done-version"' : '"reopened-version"' };
      return response(current);
    }
    return auxiliary(url) ?? result([current]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  await userEvent.click(complete()); await screen.findByRole('alert'); expect(reads(fetch)).toHaveLength(1);
  current = { ...first, etag: '"fresh-version"' }; fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Refresh activity' })); await screen.findByText(first.subject);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  complete().focus(); await userEvent.keyboard('{Enter}'); await waitFor(() => expect(reopen()).toHaveFocus());
  expect(screen.getByText('Status: Done')).toBeVisible(); expect(writes(fetch)[1]![1].headers).toMatchObject({ 'If-Match': '"fresh-version"' });
  await userEvent.keyboard(' '); await waitFor(() => expect(complete()).toHaveFocus());
  expect(screen.getByText('Status: Open')).toBeVisible(); expect(writes(fetch)[2]![1].headers).toMatchObject({ 'If-Match': '"done-version"' });
  expect(reads(fetch)).toHaveLength(4); expect(writes(fetch)).toHaveLength(3);
});

it('does not take focus back when the employee moves to another control during a pending command', async () => {
  let finish!: (value: Response) => void; let current = first;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    return auxiliary(url) ?? result([current]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  complete().focus(); await userEvent.keyboard('{Enter}'); const other = screen.getByRole('button', { name: 'All customer activities' }); other.focus();
  current = { ...first, status: 'Done' }; await act(async () => finish(response(current)));
  await screen.findByRole('button', { name: `Reopen ${first.subject}` }); expect(other).toHaveFocus();
});

it('restores the keyboard status action after closing the editor and explicitly refreshing the selected record', async () => {
  let current = first;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { current = { ...current, status: url.endsWith('/complete') ? 'Done' : 'Open' }; return response(current); }
    return auxiliary(url) ?? result([current]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  const edit = screen.getByRole('button', { name: `Edit ${first.subject}` }); edit.focus(); await userEvent.keyboard('{Enter}');
  await screen.findByRole('dialog', { name: 'Edit activity' }); await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit activity' })).not.toBeInTheDocument());
  const refresh = screen.getByRole('button', { name: 'Refresh activity' }); refresh.focus(); await userEvent.keyboard('{Enter}');
  await screen.findByText(first.subject); complete().focus(); await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(reopen()).toHaveFocus()); await userEvent.keyboard('{Enter}'); await waitFor(() => expect(complete()).toHaveFocus());
});

it.each(['missing', 'error'])('releases focus listeners after a successful status command whose replacement read is %s', async outcome => {
  let changed = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { changed = true; return response({ ...first, status: 'Done' }); }
    return auxiliary(url) ?? (changed ? outcome === 'error' ? response({}, 503) : result([]) : result());
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  const additions = vi.spyOn(document, 'addEventListener'); const removals = vi.spyOn(document, 'removeEventListener');
  complete().focus(); await userEvent.keyboard('{Enter}');
  await screen.findByText(outcome === 'error' ? 'Something went wrong' : 'This activity was not found for this customer. It may have been removed or moved.');
  await waitFor(() => {
    for (const name of ['focusin', 'pointerdown', 'keydown', 'visibilitychange']) {
      const added = additions.mock.calls.find(([event, , capture]) => event === name && (capture === true || name === 'visibilitychange'));
      expect(added).toBeDefined(); expect(removals.mock.calls).toContainEqual(added);
    }
  });
  expect(screen.queryByRole('button', { name: /^Reopen / })).not.toBeInTheDocument(); additions.mockRestore(); removals.mockRestore();
});

it('preserves an existing edit draft and its captured ETag while another row completes successfully', async () => {
  let changed = false;
  const original = { ...first, dueAt: '2025-10-26T02:30:12.345+01:00', etag: '"draft-version"' };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { changed = true; return response({ ...second, status: 'Done' }); }
    if (init.method === 'PUT') return response({ code: 'CONCURRENCY_CONFLICT' }, 412);
    return auxiliary(url) ?? result([changed ? { ...original, subject: 'Synthetic changed elsewhere', etag: '"current-version"' } : original, second]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(timelinePath); await screen.findByText(first.subject);
  const otherCommand = complete(second);
  await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` })); await screen.findByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic retained edit draft' } });
  // Another surface may settle a command while this editor owns the focus.
  fireEvent.click(otherCommand); await waitFor(() => expect(changed).toBe(true)); await screen.findByText('Synthetic changed elsewhere');
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Synthetic retained edit draft');
  expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/^This activity changed or can no longer be edited as requested/);
  const [, init] = fetch.mock.calls.find(([, init]) => init.method === 'PUT')!;
  expect(init.headers).toMatchObject({ 'If-Match': original.etag }); expect(JSON.parse(init.body as string)).toMatchObject({ subject: 'Synthetic retained edit draft', dueAt: original.dueAt });
});

it('preserves an existing edit draft when another status command conflicts without rereading', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => auxiliary(url) ?? (init.method === 'POST' ? response({}, 412) : result([first, second])));
  vi.stubGlobal('fetch', fetch); renderSelection(timelinePath); await screen.findByText(first.subject); const otherCommand = complete(second);
  await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` })); await screen.findByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic conflict-safe draft' } });
  fireEvent.click(otherCommand); await waitFor(() => expect(otherCommand).toHaveAttribute('aria-disabled', 'true'));
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Synthetic conflict-safe draft'); expect(reads(fetch)).toHaveLength(1); expect(writes(fetch)).toHaveLength(1);
});
