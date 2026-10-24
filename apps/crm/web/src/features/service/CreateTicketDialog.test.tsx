import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { answer, json, kindOf, renderService } from './serviceReadTestFixture';

afterEach(() => vi.unstubAllGlobals());
const contact = { contactId: 'contact-one', firstName: 'Synthetic', lastName: 'Contact', email: null };
const formRead = (url: string) => url.endsWith('/ticket-options') ? json({ priorities: ['Medium'], types: ['Incident'] }) : url.endsWith('/contacts') ? json([contact]) : null;
async function fill() {
  await userEvent.click(await screen.findByRole('button', { name: 'New ticket' })); await screen.findByRole('dialog', { name: 'New ticket' });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Contact' })).toBeEnabled());
  await userEvent.click(screen.getByRole('combobox', { name: 'Contact' })); await userEvent.click(await screen.findByRole('option', { name: 'Synthetic Contact' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: ' Synthetic request ' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: ' Synthetic details ' } });
}

it('preserves the queued request payload/defaults and contact field validation in the extracted form', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST'
    ? json({ errors: { ContactId: ['Synthetic contact is no longer active'] } }, 400) : formRead(url) ?? answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await fill(); await userEvent.click(screen.getByRole('button', { name: 'Create in Atera' }));
  expect(await screen.findByText('Synthetic contact is no longer active')).toBeVisible(); expect(screen.getByRole('dialog', { name: 'New ticket' })).toBeVisible();
  const posts = fetch.mock.calls.filter(([, init]) => init.method === 'POST'); expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]![1].body as string)).toEqual({ organizationId: 'o1', contactId: 'contact-one', title: 'Synthetic request', description: 'Synthetic details', priority: 'Medium', type: 'Incident' });
  expect(fetch.mock.calls.filter(([url]) => kindOf(url))).toHaveLength(6); // Five saved reads plus the POST, with no error invalidation.
}, 15_000); // A long form journey: under a loaded CI machine it needs more than the default 5 s, never a retry.

it('queues exactly once on rapid submit, refreshes only the current saved workspace and preserves the existing toast', async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; }) : formRead(url) ?? answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await fill(); const submit = screen.getByRole('button', { name: 'Create in Atera' });
  act(() => { fireEvent.click(submit); fireEvent.click(submit); }); await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1));
  await act(async () => finish(json({ id: 'request-created', status: 'Pending' })));
  expect(await screen.findByText('The ticket is being created in Atera')).toBeVisible(); expect(screen.queryByRole('dialog', { name: 'New ticket' })).not.toBeInTheDocument();
  await waitFor(() => expect(fetch.mock.calls.filter(([url, init]) => kindOf(url) && init.method === 'GET')).toHaveLength(10));
});

it.each(['Change customer', 'Change employee', 'Drop write'])('does not invalidate the new workspace, close a new form or publish late success after %s', async change => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; }) : formRead(url) ?? answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await fill(); await userEvent.click(screen.getByRole('button', { name: 'Create in Atera' }));
  fireEvent.click(screen.getByText(change)); await screen.findByText('Synthetic PC one');
  if (change !== 'Drop write') {
    await userEvent.click(await screen.findByRole('button', { name: 'New ticket' })); await screen.findByRole('dialog', { name: 'New ticket' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Contact' })).toBeEnabled());
  }
  const reads = fetch.mock.calls.filter(([, init]) => init.method === 'GET').length;
  await act(async () => finish(json({ id: 'old-request', status: 'Pending' })));
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(reads); expect(screen.queryByText('The ticket is being created in Atera')).not.toBeInTheDocument();
  if (change !== 'Drop write') expect(screen.getByRole('dialog', { name: 'New ticket' })).toBeVisible();
});

it('aborts contacts/options reads on a scope change and never shows their late old-owner content in a new form', async () => {
  let changed = false; const held: { signal: AbortSignal; finish: (value: Response) => void; options: boolean }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (!changed && (url.endsWith('/contacts') || url.endsWith('/ticket-options'))) return new Promise<Response>(resolve => { held.push({ signal: init.signal!, finish: resolve, options: url.endsWith('/ticket-options') }); });
    return formRead(url) ?? answer(kindOf(url)!);
  });
  vi.stubGlobal('fetch', fetch); renderService(); await userEvent.click(await screen.findByRole('button', { name: 'New ticket' })); await waitFor(() => expect(held).toHaveLength(2));
  changed = true; fireEvent.click(screen.getByText('Change employee')); expect(held.every(read => read.signal.aborted)).toBe(true);
  expect(screen.queryByRole('dialog', { name: 'New ticket' })).not.toBeInTheDocument();
  await act(async () => held.forEach(read => read.finish(read.options ? json({ priorities: ['Old owner priority'], types: ['Old owner type'] }) : json([{ ...contact, firstName: 'Old owner' }]))));
  await userEvent.click(await screen.findByRole('button', { name: 'New ticket' })); await screen.findByRole('dialog', { name: 'New ticket' });
  await userEvent.click(screen.getByRole('combobox', { name: 'Contact' })); expect(await screen.findByRole('option', { name: 'Synthetic Contact' })).toBeVisible();
  expect(screen.queryByText('Old owner Contact')).not.toBeInTheDocument(); expect(fetch.mock.calls.filter(([url]) => url.endsWith('/contacts'))).toHaveLength(2);
});
