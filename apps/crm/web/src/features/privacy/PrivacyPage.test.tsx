import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import type { RetentionClass, RetentionOverview } from './api';
import { PrivacyPage } from './PrivacyPage';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const emptyPage = { items: [], nextCursor: null, totalCount: 0 };

// The data classes the privacy module reports (tests/Crm.IntegrationTests/PrivacyTests.cs), each with its name on screen.
const reported: [string, string][] = [
  ['customers.former-contacts', 'Former contact persons'],
  ['identity.sessions', 'Ended sign-in sessions'],
  ['integration.exception-triage', 'Reviews of resolved exceptions'],
  ['integration.external-payloads', 'Copies of external records'],
  ['integration.sync-runs', 'Synchronization log'],
  ['integration.vendor-action-texts', 'Texts of actions sent to vendors'],
  ['sales.unconverted-leads', 'Leads that never became customers'],
  ['service.resolved-alerts', 'Resolved alerts'],
  ['service.tickets', 'Closed tickets'],
];

const retentionClass = (dataClass: string, overrides: Partial<RetentionClass> = {}): RetentionClass => ({
  dataClass, approved: false, reference: null, days: 90, proposal: true, due: 3, removed: 0, error: null, ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('Retention on the personal data page (DEV-11)', () => {
  it('names every data class the module reports and does not count a class that has no period', async () => {
    const overview: RetentionOverview = {
      mode: 'DryRun',
      policies: [],
      proposals: {},
      lastRun: {
        runId: 'r1',
        mode: 'DryRun',
        startedAt: '2026-10-21T01:36:00Z',
        finishedAt: '2026-10-21T01:36:02Z',
        failed: false,
        // Exception reviews have no proposed period (docs/04 §8): the job reports no days and counts nothing for them.
        classes: reported.map(([dataClass]) => retentionClass(dataClass, dataClass === 'integration.exception-triage' ? { days: null, due: 0 } : {})),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.startsWith('/api/v1/privacy/retention') ? overview : emptyPage)));
    renderRoutes([{ path: '/admin/privacy', element: <PrivacyPage /> }], '/admin/privacy', testUser(['privacy.manage']));

    const table = await screen.findByRole('table', { name: 'Retention per data class' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual(reported.map(([, name]) => name));
    // A code (customers.former-contacts) never stands in for a name.
    expect(table.textContent).not.toMatch(/[a-z]+\.[a-z-]+/);

    const [, period, due] = within(rows[2]!).getAllByRole('cell');
    expect(period).toHaveTextContent(/^No period\s*None proposed or approved$/);
    expect(due).toHaveTextContent(/^Not counted$/);
    const [, proposedPeriod, proposedDue] = within(rows[5]!).getAllByRole('cell');
    expect(proposedPeriod).toHaveTextContent(/^90 days\s*Proposal, not approved$/);
    expect(proposedDue).toHaveTextContent(/^3$/);
  });
});
