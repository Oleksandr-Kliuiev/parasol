import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../../test/renderWithProviders';
import type { CompareItem, ComparisonResult, KpiReport, PilotOverview, Readiness, TraceRow } from './api';
import { CompareResult } from './CompareResult';
import { HistoryView } from './HistoryPanel';
import { KpiView } from './KpiPanel';
import { ReadinessView } from './ReadinessPanel';
import { SignoffForm } from './SignoffForm';
import { TracePanel } from './TracePanel';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const STATEMENT = 'I have compared the independent figures with the CRM run, and every difference has an owner and an explanation.';

const item = (over: Partial<CompareItem>): CompareItem => ({
  key: '923456789|NOK|Subscription',
  status: 'Matched',
  reasonCode: null,
  line: null,
  orgNumber: '923456789',
  payerId: 'p1',
  currency: 'NOK',
  group: 'Subscription',
  productCode: null,
  fileRows: 1,
  fileAmount: 1000,
  crmAmount: 1000,
  difference: 0,
  fileQuantity: null,
  crmQuantity: 2,
  crmLines: 1,
  externalRefs: [],
  ...over,
});

const comparison = (items: CompareItem[], over: Partial<ComparisonResult['comparison']> = {}): ComparisonResult => ({
  documentSha256: 'a'.repeat(64),
  documentKey: 'k',
  comparison: {
    schemaVersion: 'billing-pilot-comparison/1',
    comparisonId: 'c1',
    runId: 'run1',
    periodStart: '2041-03-01',
    runStatus: 'Collected',
    runContentRevision: 3,
    contentDigest: 'd',
    fileSha256: 'f'.repeat(64),
    fileRows: items.length,
    unknownColumns: [],
    at: '2041-04-02T08:00:00Z',
    exceptionCount: items.filter((i) => i.status !== 'Matched').length,
    statusCounts: { Matched: items.filter((i) => i.status === 'Matched').length, Different: items.filter((i) => i.status === 'Different').length },
    totals: [{ currency: 'NOK', keys: items.length, exceptions: 1, fileAmount: 3000, crmAmount: 2500, difference: 500 }],
    payers: [{ payerKey: '923456789', orgNumber: '923456789', payerId: 'p1', currency: 'NOK', keys: items.length, exceptions: 1, fileAmount: 3000, crmAmount: 2500, difference: 500, status: 'Different' }],
    items,
    ...over,
  },
});

const withDifferences = () =>
  comparison([
    item({}),
    item({ key: '923456789|NOK|License', status: 'Different', reasonCode: 'AMOUNT', group: 'License', fileAmount: 2000, crmAmount: 1500, difference: 500 }),
    item({ key: '811111111|NOK|Subscription', status: 'MissingInFile', orgNumber: '811111111', fileAmount: null, crmAmount: 700, difference: null }),
  ]);

const overview = (over: Partial<PilotOverview> = {}): PilotOverview => ({ runId: 'run1', contentRevision: 3, statement: STATEMENT, comparisons: [], signoffs: [], ...over });

afterEach(() => vi.unstubAllGlobals());

describe('readiness', () => {
  const readiness: Readiness = {
    safeForParallelRun: true,
    targetPeriod: '2041-03',
    source: 'crm-web',
    caveats: ['WORKER_CONFIG_NOT_VERIFIED'],
    checks: [
      { check: 'poweroffice.sends', state: 'Blocked', ok: true, code: 'POWEROFFICE_SENDS_BLOCKED', decisive: true },
      { check: 'poweroffice.credentials', state: 'UnknownFromWeb', ok: null, code: 'WORKER_ONLY_FACT', decisive: false },
      { check: 'poweroffice.environment', state: 'Production', ok: false, code: 'POWEROFFICE_PRODUCTION', decisive: false },
    ],
  };

  it('shows ok, unknown and attention as words with their explanation, the summary and the worker caveat', () => {
    renderRoutes([{ path: '*', element: <ReadinessView readiness={readiness} /> }], '/');
    expect(screen.getByRole('status')).toHaveTextContent('Safe for a parallel run, as far as crm-web can see.');
    const rows = within(screen.getByRole('table', { name: 'Readiness checks' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('In order');
    expect(rows[2]).toHaveTextContent('Unknown');
    expect(rows[2]).toHaveTextContent('crm-web cannot know whether they are set');
    expect(rows[3]).toHaveTextContent('Look at this');
    expect(screen.getByText(/cannot read them, so those facts show as unknown/)).toBeInTheDocument();
    expect(screen.getByText(/cannot prove that it equals the configuration of crm-web/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Readiness checks' })).toHaveAttribute('tabindex', '0');
  });

  it('says plainly when a decisive check blocks the run', () => {
    renderRoutes([{ path: '*', element: <ReadinessView readiness={{ ...readiness, safeForParallelRun: false, checks: [{ ...readiness.checks[0]!, ok: false, state: 'Possible', code: 'POWEROFFICE_SENDS_POSSIBLE' }] }} /> }], '/');
    expect(screen.getByRole('status')).toHaveTextContent('Not safe for a parallel run');
    expect(screen.getByText('Blocks')).toBeInTheDocument();
  });
});

describe('comparison result', () => {
  it('shows verdicts, the difference, per-payer and per-currency totals, the id and both hashes', () => {
    renderRoutes([{ path: '*', element: <CompareResult result={withDifferences()} /> }], '/');
    expect(screen.getByText('c1')).toBeInTheDocument();
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('f'.repeat(64))).toBeInTheDocument();
    const keys = screen.getByRole('table', { name: 'Keys' });
    // Only the exceptions are listed at first.
    expect(within(keys).queryByText('923456789|NOK|Subscription')).not.toBeInTheDocument();
    const different = within(keys).getByText('923456789|NOK|License').closest('tr')!;
    expect(different).toHaveTextContent('Different');
    expect(different).toHaveTextContent('The amounts differ.');
    expect(different).toHaveTextContent(/500/);
    expect(within(keys).getByText('811111111|NOK|Subscription').closest('tr')).toHaveTextContent('Missing in file');
    expect(screen.getByRole('table', { name: 'Totals per currency' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Per payer' })).toBeInTheDocument();
    expect(screen.getByText('2 to explain before signing')).toBeInTheDocument();
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
  });

  it('shows a dash instead of zero for money the API removed', () => {
    const noMoney = comparison([item({ key: 'x', status: 'Different', reasonCode: 'AMOUNT', fileAmount: undefined, crmAmount: undefined, difference: undefined })]);
    renderRoutes([{ path: '*', element: <CompareResult result={noMoney} /> }], '/');
    const row = within(screen.getByRole('table', { name: 'Keys' })).getByText('x').closest('tr')!;
    expect(row).not.toHaveTextContent('0');
    expect(row).toHaveTextContent('—');
  });
});

describe('sign-off', () => {
  const run = { etag: '"run-etag"', contentRevision: 3 };

  const setup = (answers: Response[] = [], result = withDifferences(), ov: PilotOverview | null = overview(), onReload = vi.fn()) => {
    const fetch = vi.fn(async () => answers.shift() ?? json({}));
    vi.stubGlobal('fetch', fetch);
    const onSigned = vi.fn();
    renderRoutes(
      [{ path: '*', element: <SignoffForm result={result} overview={ov ?? undefined} run={run} onSigned={onSigned} onReload={onReload} /> }],
      '/',
      testUser(['billing.reconcile']),
    );
    return { fetch, onSigned, onReload };
  };

  const explain = async (user: ReturnType<typeof userEvent.setup>, key: string, text: string, role: string) => {
    fireEvent.change(screen.getByRole('textbox', { name: `Explanation ${key}` }), { target: { value: text } });
    await user.selectOptions(screen.getByRole('combobox', { name: `Owner ${key}` }), role);
  };

  const fillAll = async (user: ReturnType<typeof userEvent.setup>) => {
    await explain(user, '923456789|NOK|License', 'The old sheet used last year price.', 'Crm.Finance');
    await explain(user, '811111111|NOK|Subscription', 'Customer moved to another payer.', 'Crm.Sales');
    fireEvent.change(screen.getByRole('textbox', { name: /Fallback process/ }), { target: { value: 'Invoice from the old method.' } });
    await user.click(screen.getByRole('checkbox', { name: STATEMENT }));
  };

  it('asks for an explanation and an owner for every non-matched key, and says who signs', async () => {
    setup();
    const user = userEvent.setup();
    expect(screen.getByText(/You sign as Kari Nordmann/)).toBeInTheDocument();
    // Nothing that looks like a signature is prefilled.
    expect(screen.getByRole('textbox', { name: /Fallback process/ })).toHaveValue('');
    expect(screen.queryByRole('textbox', { name: /923456789\|NOK\|Subscription/ })).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Sign' });
    expect(submit).toBeDisabled();

    await explain(user, '923456789|NOK|License', 'The old sheet used last year price.', 'Crm.Finance');
    fireEvent.change(screen.getByRole('textbox', { name: /Fallback process/ }), { target: { value: 'Invoice from the old method.' } });
    await user.click(screen.getByRole('checkbox', { name: STATEMENT }));
    expect(submit).toBeDisabled(); // the second key still has nothing

    await explain(user, '811111111|NOK|Subscription', 'short', 'Crm.Sales');
    expect(submit).toBeDisabled(); // below the minimum of ten characters
    await explain(user, '811111111|NOK|Subscription', 'Customer moved to another payer.', 'Crm.Sales');
    expect(submit).toBeEnabled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Owner 811111111|NOK|Subscription' }), '');
    expect(submit).toBeDisabled(); // no owner
  });

  it('is disabled when the statement is not loaded or changed after it was ticked', async () => {
    setup([], withDifferences(), null);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign' })).toBeDisabled();
  });

  it('is disabled when the run moved on after the comparison', () => {
    renderRoutes(
      [{ path: '*', element: <SignoffForm result={withDifferences()} overview={overview()} run={{ etag: 'e', contentRevision: 4 }} onSigned={vi.fn()} onReload={vi.fn()} /> }],
      '/',
      testUser(['billing.reconcile']),
    );
    expect(screen.getByText(/Compare again\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign' })).toBeDisabled();
  });

  it('sends the run ETag, the comparison hash, every explanation and the exact statement, once', async () => {
    const { fetch, onSigned } = setup([json({ signoffId: 's1', documentSha256: 'b'.repeat(64), documentKey: 'k', signedAt: '2041-04-03T10:00:00Z', exceptionCount: 2 }, 201)]);
    const user = userEvent.setup();
    await fillAll(user);
    const submit = screen.getByRole('button', { name: 'Sign' });
    await user.dblClick(submit);

    await waitFor(() => expect(onSigned).toHaveBeenCalledOnce());
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const posts = calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/v1/billing/runs/run1/pilot/signoff');
    expect((posts[0]![1].headers as Record<string, string>)['If-Match']).toBe('"run-etag"');
    const body = JSON.parse(posts[0]![1].body as string);
    expect(body.comparisonId).toBe('c1');
    expect(body.comparisonSha256).toBe('a'.repeat(64));
    expect(body.statement).toBe(STATEMENT);
    expect(body.fallbackProcess).toBe('Invoice from the old method.');
    expect(body.explanations).toEqual([
      { key: '923456789|NOK|License', text: 'The old sheet used last year price.', ownerRole: 'Crm.Finance' },
      { key: '811111111|NOK|Subscription', text: 'Customer moved to another payer.', ownerRole: 'Crm.Sales' },
    ]);
    expect(body).not.toHaveProperty('signedBy');
  });

  it('asks before leaving with unsaved explanations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    const { router } = renderRoutes(
      [
        {
          path: '/',
          element: (
            <>
              <SignoffForm result={withDifferences()} overview={overview()} run={run} onSigned={vi.fn()} onReload={vi.fn()} />
              <a href="/other">leave</a>
            </>
          ),
        },
        { path: '/other', element: <p>elsewhere</p> },
      ],
      '/',
      testUser(['billing.reconcile']),
    );
    const user = userEvent.setup();
    // Nothing typed: leaving is free.
    await act(() => router.navigate('/other'));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    await act(() => router.navigate('/'));
    fireEvent.change(await screen.findByRole('textbox', { name: /Fallback process/ }), { target: { value: 'Something typed' } });
    await act(() => router.navigate('/other'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Leave without saving?');
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('answers 412 with a reload that keeps what was typed', async () => {
    const { onReload } = setup([json({ status: 412, code: 'CONCURRENCY_CONFLICT', title: 'CONCURRENCY_CONFLICT' }, 412)]);
    const user = userEvent.setup();
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: 'Sign' }));
    expect(await screen.findByText(/The run changed while you were working/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: /Fallback process/ })).toHaveValue('Invoice from the old method.');
  });

  it('asks to compare again on a stale comparison (409)', async () => {
    setup([json({ status: 409, code: 'BIL_PILOT_COMPARISON_STALE', title: 'BIL_PILOT_COMPARISON_STALE' }, 409)]);
    const user = userEvent.setup();
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: 'Sign' }));
    expect(await screen.findByText(/The run changed after this comparison was made/)).toBeInTheDocument();
    expect(screen.getByText(/Compare again, then sign\./)).toBeInTheDocument();
  });

  it('lists the keys the server says are unexplained', async () => {
    setup([json({ status: 409, code: 'BIL_PILOT_UNEXPLAINED', title: 'BIL_PILOT_UNEXPLAINED', keys: ['811111111|NOK|Subscription'] }, 409)]);
    const user = userEvent.setup();
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: 'Sign' }));
    const list = await screen.findByRole('list', { name: 'Keys without an explanation' });
    expect(within(list).getByText('811111111|NOK|Subscription')).toBeInTheDocument();
  });
});

describe('history', () => {
  it('lists metadata only and flags a stale comparison', () => {
    renderRoutes(
      [
        {
          path: '*',
          element: (
            <HistoryView
              overview={overview({
                comparisons: [
                  { id: 'c1', documentSha256: 'a'.repeat(64), fileSha256: 'f'.repeat(64), fileRows: 4, at: '2041-04-02T08:00:00Z', createdBy: { id: 'u1', name: 'Kari Nordmann' }, runContentRevision: 2, stale: true, exceptionCount: 2, statusCounts: {}, signoffs: 1 },
                ],
                signoffs: [
                  { id: 's1', comparisonId: 'c1', documentSha256: 'b'.repeat(64), comparisonSha256: 'a'.repeat(64), signedAt: '2041-04-03T10:00:00Z', signedBy: { id: 'u2', name: 'Per Finans' }, exceptionCount: 2, runContentRevision: 2, stale: true },
                ],
              })}
            />
          ),
        },
      ],
      '/',
    );
    expect(screen.getAllByText('Out of date')).toHaveLength(2);
    expect(screen.getByText('Per Finans')).toBeInTheDocument();
    expect(screen.getByText('Kari Nordmann')).toBeInTheDocument();
  });
});

describe('KPI', () => {
  const report: KpiReport = {
    from: '2041-01-01',
    to: '2041-03-01',
    asOf: '2041-04-05',
    runs: [
      { runId: 'r1', periodStart: '2041-03-01', kind: 'Regular', status: 'Closed', hoursCollectedToClosed: 12.5, hoursCollectedToExported: null, bases: 4, basesCancelled: 0, basesFailed: 0, basesReconciliationRequired: 0, basesWithAnomalies: 1, anomalyEntries: 2, lines: 20, manualLines: 5, manualShare: 0.25, unresolvedConflicts: 0 },
    ],
    totals: { runs: 1, closedRuns: 1, averageHoursCollectedToClosed: 12.5, lines: 20, manualLines: 5, manualShare: 0.25, anomalyEntries: 2, unresolvedConflicts: 0, basesFailed: 0, basesReconciliationRequired: 0 },
    overdueUnacknowledgedReminders: 3,
    notMeasured: [
      { kpi: 'missedRenewals', reason: 'English reason from the server' },
      { kpi: 'someFutureKpi', reason: 'Server reason for a figure the interface does not know' },
    ],
  };

  it('shows the figures, an em dash where nothing was measured and lists what is not measured with its reason', () => {
    renderRoutes([{ path: '*', element: <KpiView report={report} /> }], '/');
    const row = within(screen.getByRole('table', { name: 'Billing runs and their process figures' })).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('12.5');
    expect(row).toHaveTextContent('—');
    expect(row).toHaveTextContent('5 (25 %)');
    const list = screen.getByRole('list', { name: 'Not measured' });
    expect(within(list).getByText('Missed renewals')).toBeInTheDocument();
    expect(list).toHaveTextContent('is not marked as missed anywhere');
    // An unknown figure falls back to the server's own text instead of a raw key.
    expect(list).toHaveTextContent('Server reason for a figure the interface does not know');
    expect(screen.getByText('Overdue reminders nobody has acknowledged: 3.')).toBeInTheDocument();
  });
});

describe('trace', () => {
  const row = (over: Partial<TraceRow> = {}): TraceRow => ({
    lineId: 'l1',
    basisId: 'b1',
    runId: 'run1',
    payer: { id: 'p1', name: 'Havbris AS' },
    payerOrgNumber: '923456789',
    sourceOrganization: { id: 'o2', name: 'Datter AS' },
    group: 'Subscription',
    productCode: 'MSP-1',
    description: 'Managed services',
    sourceKey: 'contract:1',
    periodStart: '2041-03-01',
    periodEnd: '2041-03-31',
    quantity: 2,
    unitPrice: 500,
    discountPct: 0,
    vatRate: 25,
    lineTotal: 1000,
    origin: 'Collected',
    decision: 'None',
    manuallyAdjusted: false,
    changeReason: null,
    conflict: 'None',
    anomalyCodes: ['BIL_STALE_QUANTITY'],
    basisStatus: 'Draft',
    orderNo: null,
    invoiceNo: null,
    invoiceStatus: null,
    ...over,
  });

  const show = (permissions: string[], rows: TraceRow[], total = rows.length, next: string | null = null) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/trace')) return json({ items: rows, nextCursor: next, totalCount: total });
        return json([]);
      }),
    );
    renderRoutes([{ path: '*', element: <TracePanel runId="run1" /> }], '/', testUser(permissions));
  };

  it('shows money columns only when the API returned them, and N of M', async () => {
    show(['billing.read', 'finance.read'], [row()], 120, 'cursor');
    expect(await screen.findByText('Havbris AS')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Line total' })).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Lines of the run' })).toHaveAttribute('tabindex', '0');
  });

  it('has no money columns without finance.read', async () => {
    show(['billing.read'], [row({ unitPrice: undefined, discountPct: undefined, lineTotal: undefined })]);
    expect(await screen.findByText('Havbris AS')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Line total' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Unit price' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'VAT' })).toBeInTheDocument();
  });
});
