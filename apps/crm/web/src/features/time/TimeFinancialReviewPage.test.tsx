import { expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link } from 'react-router';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TimeFinancialReviewPage } from './TimeFinancialReviewPage';
import { financialReviewPermissions } from './financialReviewAccess';
import { parseFinancialReview } from './financialReviewContract';
import { financialReviewFixture, reviewEntryId } from './financialReviewFixture';

const route = '/time/entries/:id/financial-review';
const path = `/time/entries/${reviewEntryId}/financial-review`;
const show = (permissions: string[] = financialReviewPermissions) =>
  renderRoutes([page(<TimeFinancialReviewPage />, route)], path, testUser(permissions));

it('shows saved comparisons and exact related links without financial mutation controls', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(financialReviewFixture()))); vi.stubGlobal('fetch', fetch);
  show();
  expect(await screen.findByRole('link', { name: 'Synthetic review bank' })).toHaveAttribute('href', '/contracts/hour-banks/33333333-3333-4333-8333-333333333333');
  expect(screen.getByRole('link', { name: 'Open billing record' })).toHaveAttribute('href', '/billing/bases/44444444-4444-4444-8444-444444444444');
  expect(screen.getByText('No discrepancy found in the checked records.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /Approve|Withdraw|Cancel|Adjust|Repair/i })).toBeNull();
  expect(fetch.mock.calls.every(call => (call as unknown[]).length < 2 || (((call as unknown[])[1] as RequestInit).method ?? 'GET') === 'GET')).toBe(true);
});

it('does not fetch financial details when a single required permission is missing', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  show(financialReviewPermissions.filter(p => p !== 'finance.read'));
  expect(screen.getByText(/This review requires Finance/)).toBeVisible(); expect(fetch).not.toHaveBeenCalled();
});

it('explains a mismatch and renders stored names as text', async () => {
  const report = financialReviewFixture(); report.banks[0]!.name = '<script>synthetic()</script>';
  report.banks[0]!.netHours = 1; report.banks[0]!.consumedHours = 1;
  report.requiresReview = true; report.findings = [{ code: 'BANK_ALLOCATION_MISMATCH', level: 'Review' }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(report)))); show();
  expect(await screen.findByText(/Hours on the current approval differ/)).toBeVisible();
  expect(screen.getByText('<script>synthetic()</script>')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByText('No discrepancy found in the checked records.')).toBeNull();
});

it('hides the old report during refresh and keeps it hidden after access is refused', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(r => { resolve = r; }); let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? new Response(JSON.stringify(financialReviewFixture())) : pending));
  show(); await screen.findByRole('link', { name: 'Synthetic review bank' });
  const refresh = screen.getByRole('button', { name: 'Refresh saved facts' }); await userEvent.click(refresh);
  expect(screen.queryByRole('link', { name: 'Synthetic review bank' })).toBeNull();
  expect(refresh).toHaveAttribute('aria-disabled', 'true');
  resolve(new Response(JSON.stringify({ code: 'AUTH_FORBIDDEN', message: 'Forbidden' }), { status: 403 }));
  await waitFor(() => expect(refresh).not.toHaveAttribute('aria-disabled', 'true'));
  expect(screen.queryByText('No discrepancy found in the checked records.')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Synthetic review bank' })).toBeNull();
});

it('cancels a previous entry read and ignores its late result after navigation', async () => {
  const next = '55555555-5555-4555-8555-555555555555'; let firstSignal: AbortSignal | undefined; let release!: (response: Response) => void;
  const pending = new Promise<Response>(r => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(reviewEntryId)) { firstSignal = init?.signal as AbortSignal; return pending; }
    const report = financialReviewFixture(next); report.organizationName = 'Synthetic next customer'; return new Response(JSON.stringify(report));
  }));
  renderRoutes([page(<><Link to={`/time/entries/${next}/financial-review`}>Next entry</Link><TimeFinancialReviewPage /></>, route)], path, testUser(financialReviewPermissions));
  await waitFor(() => expect(firstSignal).toBeDefined()); await userEvent.click(screen.getByRole('link', { name: 'Next entry' }));
  expect(await screen.findByRole('link', { name: 'Synthetic next customer' })).toBeVisible(); expect(firstSignal!.aborted).toBe(true);
  release(new Response(JSON.stringify(financialReviewFixture())));
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Synthetic review customer' })).toBeNull());
});

it('rejects another entry response and inconsistent review flags before rendering any source details', () => {
  const report = financialReviewFixture();
  expect(() => parseFinancialReview(report, '55555555-5555-4555-8555-555555555555')).toThrow();
  expect(() => parseFinancialReview({ ...report, requiresReview: true }, reviewEntryId)).toThrow();
  expect(() => parseFinancialReview({ ...report, banks: [report.banks[0], report.banks[0]] }, reviewEntryId)).toThrow();
});

it('does not turn an invalid successful response into an empty or clear financial report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, entryId: reviewEntryId })))); show();
  await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByText('No discrepancy found in the checked records.')).toBeNull();
  expect(screen.queryByText('No linked hour bank movements or current bank allocations.')).toBeNull();
});

it('accepts the CRM SQL-sortable GUID format without treating it as an RFC UUID', () => {
  const id = '8c2ebfc1-9512-c3de-0000-0199ee998877';
  expect(parseFinancialReview(financialReviewFixture(id), id).entryId).toBe(id);
});
