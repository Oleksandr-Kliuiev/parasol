import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { auxiliary, first, isActivityRead, organizationId, renderSelection, response, result } from './activityNavigationTestFixture';

afterEach(() => vi.unstubAllGlobals());

it('retains the exact edit draft, due instant and captured ETag when the selected read refreshes', async () => {
  let reads = 0;
  const original = { ...first, dueAt: '2025-10-26T02:30:12.345+01:00', etag: '"original-version"' };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') return response({ code: 'CONCURRENCY_CONFLICT' }, 412);
    return auxiliary(url) ?? result([++reads === 1 ? original : { ...original, subject: 'Changed elsewhere', etag: '"new-version"' }]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` }));
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic retained draft' } });
  fireEvent.click(screen.getByText('Refresh current query')); await waitFor(() => expect(reads).toBe(2));
  expect(await screen.findByText('Changed elsewhere')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Synthetic retained draft');
  expect(screen.getByText('Selected activity')).not.toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/^This activity changed or can no longer be edited as requested/)).toBeVisible();
  const writes = fetch.mock.calls.filter(([, init]) => init.method === 'PUT'); expect(writes).toHaveLength(1);
  expect(writes[0]![1].headers).toMatchObject({ 'If-Match': '"original-version"' });
  expect(JSON.parse(writes[0]![1].body as string)).toMatchObject({ subject: 'Synthetic retained draft', dueAt: original.dueAt });
});

it('hides a selected record and its source controls on a failed refresh and does not restore an old draft after retry', async () => {
  let failed = false;
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? (failed ? response({ detail: 'Synthetic read failure' }, 503) : result()));
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` }));
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic draft to discard' } });
  failed = true; fireEvent.click(screen.getByText('Refresh current query'));
  expect(await screen.findByText('Something went wrong')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument();
  failed = false; await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(first.subject)).toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('discards a draft after a confirmed empty refetch and does not revive it if the same ID later becomes available', async () => {
  let empty = false;
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? result(empty ? [] : [first]));
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` })); await screen.findByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic deleted draft' } });
  empty = true; fireEvent.click(screen.getByText('Refresh current query'));
  expect(await screen.findByText('This activity was not found for this customer. It may have been removed or moved.')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  empty = false; fireEvent.click(screen.getByText('Refresh current query')); await screen.findByText(first.subject);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByDisplayValue('Synthetic deleted draft')).not.toBeInTheDocument();
});

it('explicit keyboard refresh reads the current version once, retains focus and permits a new editor with its new ETag', async () => {
  let finish!: (value: Response) => void; let reads = 0;
  const fresh = { ...first, subject: 'Synthetic fresh version', etag: '"new-version"' };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') return response(fresh);
    if (!isActivityRead(url)) return auxiliary(url)!;
    if (++reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
    return result(reads === 1 ? [first] : [fresh]);
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  const refresh = screen.getByRole('button', { name: 'Refresh activity' }); refresh.focus(); await userEvent.keyboard('{Enter}');
  expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByText(first.subject)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument();
  await userEvent.keyboard('{Enter} '); fireEvent.click(refresh); expect(reads).toBe(2);
  await act(async () => finish(result([fresh]))); expect(await screen.findByText(fresh.subject)).toBeVisible(); expect(refresh).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: `Edit ${fresh.subject}` })); await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1));
  expect(fetch.mock.calls.find(([, init]) => init.method === 'PUT')![1].headers).toMatchObject({ 'If-Match': '"new-version"' });
});

it.each(['success', 'failure'])('suppresses a late completion %s after the employee changes', async outcome => {
  let finish!: (value: Response) => void; let writes = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { ++writes; return new Promise<Response>(resolve => { finish = resolve; }); }
    return auxiliary(url) ?? result();
  });
  vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: `Mark ${first.subject} as done` }));
  await waitFor(() => expect(writes).toBe(1)); await userEvent.click(screen.getByRole('button', { name: 'Change employee' }));
  await screen.findByText(first.subject);
  await act(async () => finish(outcome === 'success' ? response(first) : response({ detail: 'Synthetic old completion error' }, 500)));
  expect(screen.queryByText('Marked as done')).not.toBeInTheDocument(); expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(screen.queryByText('Synthetic old completion error')).not.toBeInTheDocument(); expect(writes).toBe(1);
});

it.each(['success', 'failure'])('suppresses a late calendar synchronization %s after the employee changes', async outcome => {
  let finish!: (value: Response) => void; let writes = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/outlook/status')) return response({ calendar: true, mail: false });
    if (init.method === 'POST') { ++writes; return new Promise<Response>(resolve => { finish = resolve; }); }
    return auxiliary(url) ?? result();
  });
  vi.stubGlobal('fetch', fetch); renderSelection(`/organizations/${organizationId}?tab=activities`);
  await userEvent.click(await screen.findByRole('button', { name: 'Read changes from Outlook' }));
  await waitFor(() => expect(writes).toBe(1)); await userEvent.click(screen.getByRole('button', { name: 'Change employee' }));
  await screen.findByText(first.subject);
  await act(async () => finish(outcome === 'success' ? response({ updated: 3, read: 3 }) : response({ detail: 'Synthetic old calendar error' }, 500)));
  expect(screen.queryByText('Read from Outlook: 3 meetings updated')).not.toBeInTheDocument(); expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(screen.queryByText('Synthetic old calendar error')).not.toBeInTheDocument(); expect(writes).toBe(1);
  // A confirmed write invalidates the current employee's read; the old UI lifetime must still stay silent.
  expect(fetch.mock.calls.filter(([url]) => isActivityRead(url))).toHaveLength(outcome === 'success' ? 3 : 2);
});
