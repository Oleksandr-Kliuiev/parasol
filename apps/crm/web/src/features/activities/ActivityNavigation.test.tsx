import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { activitySelection, activityUrl } from './activityNavigation';
import { activityId, auxiliary, first, isActivityRead, organizationId, otherActivityId, otherOrganizationId,
  renderSelection, response, result, second, selectedPath } from './activityNavigationTestFixture';

const invalid = 'This activity link is invalid. Choose all customer activities to continue.';
const missing = 'This activity was not found for this customer. It may have been removed or moved.';
const readCalls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => isActivityRead(url as string));
afterEach(() => vi.unstubAllGlobals());

it('accepts canonical COMB and uppercase GUIDs and generates an exact encoded URL', () => {
  expect(activitySelection(new URLSearchParams(`activityId=${activityId.toUpperCase()}`))).toEqual({ kind: 'selected', activityId });
  expect(activitySelection(new URLSearchParams('tab=activities'))).toEqual({ kind: 'all' });
  expect(activityUrl('customer/one', activityId)).toBe(`/organizations/customer%2Fone?tab=activities&activityId=${activityId}`);
});

it.each(['', 'not-a-guid', '00000000-0000-0000-0000-000000000000', `${activityId}&activityId=${activityId}`])(
  'fails closed without a timeline read or editor for an invalid or ambiguous link: %s', async id => {
    const fetch = vi.fn(async (url: string) => auxiliary(url) ?? result()); vi.stubGlobal('fetch', fetch); renderSelection(selectedPath(id));
    expect(await screen.findByText(invalid)).toBeVisible(); expect(readCalls(fetch)).toHaveLength(0);
    expect(screen.queryByText(first.subject)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Edit Synthetic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  },
);

it('reads only the exact record once, focuses the selection and offers no paging', async () => {
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? result()); vi.stubGlobal('fetch', fetch); renderSelection();
  expect(await screen.findByText(first.subject)).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Selected activity' })).toHaveFocus();
  expect(within(screen.getByRole('region', { name: 'Activities' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('Status: Open')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  const [url] = readCalls(fetch)[0]!; expect(new URL(url, 'https://synthetic.invalid').searchParams.toString()).toBe(`organizationId=${organizationId}&activityId=${activityId}&limit=1`);
  fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online'));
  expect(readCalls(fetch)).toHaveLength(1);
});

it('keeps a missing selection distinct from an empty customer timeline, with no broad fallback', async () => {
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? result([])); vi.stubGlobal('fetch', fetch); renderSelection();
  expect(await screen.findByText(missing)).toBeVisible(); expect(screen.queryByText('Nothing logged yet.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Log activity' })).not.toBeInTheDocument(); expect(readCalls(fetch)).toHaveLength(1);
});

it.each(['wrong-record', 'wrong-customer', 'extra-record', 'cursor', 'wrong-total'])('refuses an inconsistent exact response: %s', async mismatch => {
  const items = mismatch === 'wrong-record' ? [second] : mismatch === 'wrong-customer' ? [{ ...first, organizationId: otherOrganizationId }]
    : mismatch === 'extra-record' ? [first, second] : [first];
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? response({ items, nextCursor: mismatch === 'cursor' ? 'unexpected-page' : null,
    totalCount: mismatch === 'wrong-total' ? 61 : items.length }));
  vi.stubGlobal('fetch', fetch); renderSelection(); expect((await screen.findAllByText('Something went wrong'))[0]).toBeVisible();
  expect(screen.queryByText(first.subject)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Edit Synthetic/ })).not.toBeInTheDocument();
  expect(readCalls(fetch)).toHaveLength(1);
});

it('offers a manual retry after an exact read error and does not show an empty or stale record', async () => {
  let failed = true; const fetch = vi.fn(async (url: string) => auxiliary(url) ?? (failed ? response({ detail: 'Synthetic failure' }, 503) : result()));
  vi.stubGlobal('fetch', fetch); renderSelection(); expect(await screen.findByText('Something went wrong')).toBeVisible();
  expect(screen.queryByText(missing)).not.toBeInTheDocument(); expect(readCalls(fetch)).toHaveLength(1);
  failed = false; await userEvent.click(screen.getByRole('button', { name: 'Try again' })); expect(await screen.findByText(first.subject)).toBeVisible();
  expect(readCalls(fetch)).toHaveLength(2); expect(readCalls(fetch).every(([url]) => url.includes(`activityId=${activityId}`))).toBe(true);
});

it('shows the ordinary timeline only after an explicit All customer activities action and preserves other URL parameters', async () => {
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? (url.includes('activityId=') ? result() : result([first, second])));
  vi.stubGlobal('fetch', fetch); const view = renderSelection(selectedPath(activityId, '&keep=synthetic')); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: 'All customer activities' })); expect(await screen.findByText(second.subject)).toBeVisible();
  expect(view.router.state.location.search).toBe('?tab=activities&keep=synthetic'); expect(readCalls(fetch)).toHaveLength(2);
  expect(screen.queryByRole('heading', { name: 'Selected activity' })).not.toBeInTheDocument();
});

it('allows a generic technical task to be read without write access', async () => {
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? result()); vi.stubGlobal('fetch', fetch); renderSelection(selectedPath(), ['activities.read']);
  expect(await screen.findByText(first.subject)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Edit Synthetic/ })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /^Mark .* as done$/ })).not.toBeInTheDocument();
  expect(readCalls(fetch)).toHaveLength(1);
});

it('does not read or reveal an activity without activities.read', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); renderSelection(selectedPath(), ['activities.write']);
  expect(screen.queryByRole('region', { name: 'Activities' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['Change selection', 'Change customer', 'Change employee', 'Drop write', 'Replace URL', 'Drop read'])(
  'aborts a previous exact read and ignores its late reply after %s', async change => {
    let finish!: (value: Response) => void; let signal!: AbortSignal; let reads = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (!isActivityRead(url)) return auxiliary(url)!;
      if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      return result(change === 'Change selection' ? [second] : []);
    });
    vi.stubGlobal('fetch', fetch); renderSelection(); await waitFor(() => expect(reads).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: change })); expect(signal.aborted).toBe(true);
    if (change === 'Change selection') expect(await screen.findByText(second.subject)).toBeVisible();
    else if (change !== 'Drop read') expect(await screen.findByText(missing)).toBeVisible();
    await act(async () => finish(result())); expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
    expect(reads).toBe(change === 'Drop read' ? 1 : 2);
  },
);

it.each(['Change selection', 'Change customer', 'Change employee', 'Drop write', 'Replace URL', 'Drop read'])(
  'unmounts a selected edit draft after %s', async change => {
    const fetch = vi.fn(async (url: string) => auxiliary(url) ?? (url.includes(otherActivityId) ? result([second]) : url.includes(otherOrganizationId) ? result([]) : result()));
    vi.stubGlobal('fetch', fetch); renderSelection(); await screen.findByText(first.subject);
    await userEvent.click(screen.getByRole('button', { name: `Edit ${first.subject}` }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Synthetic unsaved draft' } });
    fireEvent.click(screen.getByText(change)); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Synthetic unsaved draft')).not.toBeInTheDocument();
  },
);
