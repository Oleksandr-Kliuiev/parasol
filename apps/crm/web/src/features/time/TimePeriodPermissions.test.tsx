import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TimeEntriesPage } from './TimeEntriesPage';

const fixture = vi.hoisted(() => ({ closed: true, reopen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock('./api', async importActual => ({ ...(await importActual<typeof import('./api')>()),
  useTimeEntries: () => ({ latest: { summary: { hours: 0, approvedHours: 0, newHours: 0, amount: 0 }, totalCount: 0 },
    items: [], error: null, isPending: false, hasNextPage: false, isFetchingNextPage: false }),
  usePeriods: () => ({ data: [{ year: 2032, month: 3, isClosed: fixture.closed, closedAt: null, closedByName: null, reopenReason: null, newEntries: 0, hours: 0 }] }),
  useTimeActions: () => ({}),
  usePeriodActions: () => ({ close: { mutateAsync: fixture.close }, reopen: { mutateAsync: fixture.reopen, isPending: false, error: null } }),
}));
beforeEach(() => { fixture.closed = true; fixture.reopen.mockClear(); fixture.close.mockClear(); });
const render = (permissions: string[]) => renderRoutes([page(<TimeEntriesPage />)], '/time/entries?year=2032&month=3', testUser(permissions));

it('Finance can reopen with a reason using TimeUnlock without receiving time approval or closing controls', async () => {
  render(['time.read', 'time.unlock', 'finance.read']);
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
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
  expect(screen.getByRole('button', { name: /^Approve/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
});

it('Finance TimeUnlock on an open month does not grant TimeManage closing rights', () => {
  fixture.closed = false; render(['time.read', 'time.unlock', 'finance.read']);
  expect(screen.queryByRole('button', { name: 'Close the period' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
});
