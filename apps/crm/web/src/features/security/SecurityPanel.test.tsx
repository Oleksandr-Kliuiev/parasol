import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { formatReadAt } from '../../shared/utils/format';
import { SecurityPanel } from './SecurityPanel';
import type { SecurityOverview, SecurityRead, SummaryReport, Usage } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const read = (job: string, overrides: Partial<SecurityRead> = {}): SecurityRead =>
  ({ system: 'huntress', job, startedAt: '2026-10-22T06:25:00Z', complete: true, late: false, ...overrides });

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  system: 'huntress', externalOrganizationId: 501, name: 'Fjord IT AS', agentsCount: 14, billableAgents: 12, unresponsiveAgents: 2, outdatedAgents: null,
  isolatedAgents: 0, billableIdentities: null, satLearners: null, billableLogSources: null, readAt: '2026-10-22T06:25:00Z', ...overrides,
});

const report = (overrides: Partial<SummaryReport> = {}): SummaryReport => ({
  system: 'huntress', externalId: 9001, type: 'monthly_summary', periodStart: '2026-09-01', periodEnd: '2026-09-30', agentsCount: 14,
  incidentsReported: 3, incidentsResolved: 2, signalsDetected: 1250, signalsInvestigated: 40,
  url: 'https://huntress.example.invalid/rails/active_storage/blobs/redirect/synthetic.pdf?disposition=download', ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

function show(overview: Partial<SecurityOverview>) {
  const fetch = vi.fn(async () => json({ usage: [], reports: [], reportsTotal: 0, reads: [], ...overview }));
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<SecurityPanel organizationId="o1" scope={{ owner: 'u1', revision: 0 }} />)], '/', testUser(['service.read']));
  return fetch;
}

const figure = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('div')!;

describe('Security in the Drift tab (M41)', () => {
  it('shows what Huntress counts for each linked organization, in the warning tone only above zero and a dash for what it did not give', async () => {
    const fetch = show({ usage: [usage()], reports: [report()], reportsTotal: 1, reads: [read('huntress-organizations'), read('huntress-reports')] });
    const panel = within(await screen.findByRole('region', { name: 'Security' }));
    expect(fetch).toHaveBeenCalledWith('/api/v1/security/organizations/o1/overview', expect.anything());
    expect(await panel.findByRole('heading', { name: 'Fjord IT AS (Huntress)' })).toBeVisible();
    expect(panel.getByRole('region', { name: 'What Huntress counts for Fjord IT AS' })).toBeVisible();

    expect(within(figure('Agents billed')).getByText('12')).toBeVisible();
    expect(within(figure('Agents billed')).getByText('14 agents in all')).toBeVisible();
    // A figure above zero carries its tone; a zero is a plain figure, and a figure Huntress did not give is a dash.
    const unresponsive = within(figure('Not responding')).getByText('2');
    expect(unresponsive).not.toHaveAttribute('style');
    expect(unresponsive.className).not.toBe('');
    expect(within(figure('Isolated')).getByText('0')).toHaveStyle({ display: 'inline-block' });
    expect(within(figure('Outdated')).getByText('—')).toBeVisible();
    // Identities and learners only when Huntress counts them for the organization.
    expect(screen.queryByText('Identities billed', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Training users', { selector: 'dt' })).not.toBeInTheDocument();

    // How fresh the figures and the reports are, from the reads they come from.
    expect(panel.getByText(`Organizations and usage (Huntress) read at ${formatReadAt('2026-10-22T06:25:00Z')} · `
      + `Monthly reports (Huntress) read at ${formatReadAt('2026-10-22T06:25:00Z')}`)).toBeVisible();
  });

  it('lists the monthly reports by month with their incidents and the way to the PDF in Huntress, and says when more exist', async () => {
    show({
      usage: [usage({ billableIdentities: 30, satLearners: 9 })],
      reports: [report(), report({ externalId: 9002, periodStart: '2026-08-01', periodEnd: '2026-08-31', incidentsReported: null, url: null })],
      reportsTotal: 14, reads: [read('huntress-organizations'), read('huntress-reports')],
    });
    const table = await screen.findByRole('table', { name: 'Monthly reports' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['September 2026', '3 reported, 2 closed', '1,250', '14', 'Huntress']);
    const pdf = within(rows[0]!).getByRole('link', { name: 'Open the report for September 2026 in Huntress' });
    expect(pdf).toHaveAttribute('href', 'https://huntress.example.invalid/rails/active_storage/blobs/redirect/synthetic.pdf?disposition=download');
    expect(pdf).toHaveAttribute('target', '_blank');
    // A report without figures or a link says so with dashes, never with zeros.
    expect(within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['August 2026', '—', '1,250', '14', '—']);
    expect(screen.getByText('The latest 2 of 14 reports.')).toBeVisible();
    expect(within(figure('Identities billed')).getByText('30')).toBeVisible();
    expect(within(figure('Training users')).getByText('9')).toBeVisible();
  });

  it('says no organization is linked once Huntress was read, and that Huntress was never read otherwise — never zero agents', async () => {
    show({ reads: [read('huntress-organizations'), read('huntress-reports', { startedAt: null, complete: false })] });
    const panel = within(await screen.findByRole('region', { name: 'Security' }));
    expect(await panel.findByText('Huntress has given no figures for this customer yet. If its Huntress organization is not linked, link it under Mappings; the figures come with the next read (hourly).')).toBeVisible();
    expect(panel.queryByText('Agents billed')).not.toBeInTheDocument();
    expect(panel.queryByRole('table')).not.toBeInTheDocument();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();

    show({ reads: [read('huntress-organizations', { startedAt: null, complete: false }), read('huntress-reports', { startedAt: null, complete: false })] });
    const unread = within(await screen.findByRole('region', { name: 'Security' }));
    expect(await unread.findByText('Huntress has not been read yet.')).toBeVisible();
    expect(unread.getByText('Organizations and usage (Huntress) not read yet · Monthly reports (Huntress) not read yet')).toBeVisible();
  });

  it('says a linked organization has no reports yet, and that the reports were not read before their first read', async () => {
    show({ usage: [usage()], reads: [read('huntress-organizations'), read('huntress-reports')] });
    expect(await screen.findByText('No monthly reports from Huntress in the last 13 months.')).toBeVisible();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();

    // The organizations were read but the daily reports job never ran: "none" would be a claim no read made.
    show({ usage: [usage()], reads: [read('huntress-organizations'), read('huntress-reports', { startedAt: null, complete: false })] });
    expect(await screen.findByText('Monthly reports have not been read yet.')).toBeVisible();
    expect(screen.queryByText('No monthly reports from Huntress in the last 13 months.')).not.toBeInTheDocument();
  });

  it('names only the reported incidents of a report Huntress gave no closed count for, never a zero', async () => {
    show({ usage: [usage()], reports: [report({ incidentsResolved: null })], reportsTotal: 1, reads: [read('huntress-organizations'), read('huntress-reports')] });
    const table = within(await screen.findByRole('table', { name: 'Monthly reports' }));
    expect(table.getByRole('cell', { name: '3 reported' })).toBeVisible();
  });

  it('is left out where Huntress is switched off and was never read, instead of saying "not read yet" for good', async () => {
    // The overview names no read of a source switched off and never read, and has no figures or reports from it.
    const fetch = show({});
    // While the overview is read the panel says so; once it is read the panel goes.
    expect(await screen.findByRole('region', { name: 'Security' })).toBeVisible();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Security' })).not.toBeInTheDocument());
    expect(screen.queryByText('Huntress has not been read yet.')).not.toBeInTheDocument();
  });
});
