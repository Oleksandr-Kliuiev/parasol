import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TimeEntriesPage } from './TimeEntriesPage';
import { entry } from './timeEntryTestFixture';
import type { TimeEntry } from './types';

const fixture = vi.hoisted(() => ({ closed: true, waiting: 0, items: [] as TimeEntry[], reopen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock('./api', async importActual => ({ ...(await importActual<typeof import('./api')>()),
  useTimeEntries: () => ({ latest: { summary: { hours: 0, approvedHours: 0, newHours: 0, amount: 0 }, totalCount: fixture.items.length },
    items: fixture.items, error: null, isPending: false, hasNextPage: false, isFetchingNextPage: false }),
  usePeriods: () => ({ data: [{ year: 2032, month: 3, isClosed: fixture.closed, closedAt: null, closedByName: null, reopenReason: null, newEntries: fixture.waiting, hours: 0 }] }),
  useTimeActions: () => ({}),
  usePeriodActions: () => ({ close: { mutateAsync: fixture.close, isPending: false, error: null, reset: () => undefined },
    reopen: { mutateAsync: fixture.reopen, isPending: false, error: null } }),
}));
beforeEach(() => { fixture.closed = true; fixture.waiting = 0; fixture.items = []; fixture.reopen.mockClear(); fixture.close.mockClear(); });
const render = (permissions: string[]) => renderRoutes([page(<TimeEntriesPage />)], '/time/entries?year=2032&month=3', testUser(permissions));

it('Finance can reopen with a reason using TimeUnlock without receiving time approval or closing controls', async () => {
  render(['time.read', 'time.unlock', 'finance.read']);
  expect(screen.queryByRole('button', { name: /^Approve \(/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Withdraw/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  const dialog = screen.getByRole('dialog', { name: /^Reopen/ }); expect(dialog).toBeVisible();
  const submit = screen.getAllByRole('button', { name: 'Reopen' }).find(button => dialog.contains(button))!;
  expect(submit).toBeDisabled(); fireEvent.change(screen.getByRole('textbox', { name: /^Reason/ }), { target: { value: 'Reviewed correction' } });
  await userEvent.click(submit);
  await waitFor(() => expect(fixture.reopen).toHaveBeenCalledWith({ year: 2032, month: 3, reason: 'Reviewed correction' }));
  expect(fixture.close).not.toHaveBeenCalled();
});

it('a ServiceLead managing hours does not gain Finance reopening rights', () => {
  render(['time.read', 'time.manage', 'time.own']);
  // The closed month is on screen with its state; nothing in it can be approved any more, and reopening is Finance's.
  expect(within(screen.getByRole('region', { name: 'March 2032' })).getByText('Closed')).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Approve \(/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
});

it('a ServiceLead approves the selected entries of an open month', async () => {
  fixture.closed = false; fixture.items = [{ ...entry, organizationName: 'Synthetic customer' }];
  render(['time.read', 'time.manage', 'time.own']);
  // Nothing selected: the approval waits for a choice instead of showing a button that cannot act.
  expect(screen.queryByRole('button', { name: /^Approve \(/ })).toBeNull();
  expect(screen.getByRole('button', { name: /^Close .+…$/ })).toBeVisible();
  await userEvent.click(screen.getByRole('checkbox', { name: /^Select the entry of/ }));
  expect(screen.getByRole('button', { name: 'Approve (1)' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Withdraw approval/ })).toBeNull();
});

it('Finance TimeUnlock on an open month does not grant TimeManage closing rights', () => {
  fixture.closed = false; render(['time.read', 'time.unlock', 'finance.read']);
  expect(screen.queryByRole('button', { name: /^Close .+…$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
});

it('closing a month asks first, names it and holds the close back while entries wait', async () => {
  fixture.closed = false; fixture.waiting = 2; render(['time.read', 'time.manage', 'time.own']);
  await userEvent.click(screen.getByRole('button', { name: 'Close March 2032…' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Close March 2032?' }));
  expect(dialog.getByText(/^2 entries in March 2032 still wait for approval/)).toBeVisible();
  expect(dialog.getByRole('link', { name: 'Show waiting entries' })).toHaveAttribute('href', '/time/entries?year=2032&month=3&status=New');
  expect(dialog.getByRole('button', { name: 'Close March 2032' })).toBeDisabled();
  await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(fixture.close).not.toHaveBeenCalled();
});

it('closing a month that has not ended says so, and closes only after the confirmation', async () => {
  fixture.closed = false; render(['time.read', 'time.manage', 'time.own']);
  await userEvent.click(screen.getByRole('button', { name: 'Close March 2032…' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Close March 2032?' }));
  expect(dialog.getByText(/^March 2032 has not ended yet/)).toBeVisible();
  expect(fixture.close).not.toHaveBeenCalled();
  await userEvent.click(dialog.getByRole('button', { name: 'Close March 2032' }));
  await waitFor(() => expect(fixture.close).toHaveBeenCalledWith({ year: 2032, month: 3 }));
});
