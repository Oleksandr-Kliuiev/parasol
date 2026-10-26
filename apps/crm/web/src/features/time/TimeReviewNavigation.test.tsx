import { expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TimeEntriesPage } from './TimeEntriesPage';
import { financialReviewPermissions } from './financialReviewAccess';
import { entry as savedEntry } from './timeEntryTestFixture';

const reads = vi.hoisted(() => vi.fn());
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  useTimeEntries: (filters: unknown) => { reads(filters); return { latest: { summary: {}, totalCount: 1 },
    items: [{ ...savedEntry, id: '11111111-1111-4111-8111-111111111111', status: 'Approved', reviewNote: 'Synthetic saved review' }],
    isPending: false, error: null, hasNextPage: false, isFetchingNextPage: false }; },
  usePeriods: () => ({ data: [] }), useTimeActions: () => ({}), usePeriodActions: () => ({}),
}));

it('Finance opens one exact review and the saved-note filter starts a new server filter', async () => {
  const view = renderRoutes([page(<TimeEntriesPage />)], '/time/entries?year=2026&month=10', testUser(financialReviewPermissions));
  expect(screen.getByRole('link', { name: 'Financial review' })).toHaveAttribute('href', '/time/entries/11111111-1111-4111-8111-111111111111/financial-review');
  const savedNotes = within(screen.getByRole('group', { name: 'Only entries with saved review notes in this period' }));
  await userEvent.click(savedNotes.getByRole('button', { name: 'With review notes' }));
  await waitFor(() => expect(view.router.state.location.search).toContain('reviewOnly=true'));
  expect(reads).toHaveBeenLastCalledWith(expect.objectContaining({ reviewOnly: true }));
  expect(savedNotes.getByRole('button', { name: 'With review notes' })).toHaveAttribute('aria-pressed', 'true');
});

it('a ServiceLead reading time does not receive the Finance diagnostic link', () => {
  renderRoutes([page(<TimeEntriesPage />)], '/time/entries?year=2026&month=10', testUser(['time.read', 'contracts.read', 'billing.read', 'customers.read']));
  expect(screen.queryByRole('link', { name: 'Financial review' })).toBeNull();
});
