import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { BillingBasisPage } from './BillingBasisPage';
import type { Basis, BasisLine, BasisStatus } from './types';

const line: BasisLine = {
  id: 'l1',
  group: 'Subscription',
  productId: null,
  productName: null,
  productCode: null,
  description: 'Managed services (01.09.2032–30.09.2032)',
  quantity: 1,
  unitPrice: 6000,
  discountPct: 0,
  vatRate: 25,
  lineTotal: 6000,
  manuallyAdjusted: false,
  sourceRefs: null,
  origin: 'Collected',
  sourceKey: 'contract:x:2032-09-01:2032-09-30',
  sourceOrganization: null,
  decision: 'None',
  conflict: 'None',
  sourceDescription: null,
  sourceQuantity: null,
  sourceUnitPrice: null,
  sourceDiscountPct: null,
  sourceLineTotal: null,
  changeReason: null,
  changedBy: null,
  changedAt: null,
};

function basis(status: BasisStatus, sendStarted: boolean): Basis {
  return {
    id: 'b1',
    runId: 'r1',
    periodStart: '2032-09-01',
    periodEnd: '2032-09-30',
    runStatus: 'ExportedWithErrors',
    organization: { id: 'o1', name: 'Havbris AS' },
    status,
    totalExVat: 6000,
    previousPeriodTotal: 0,
    anomalies: [],
    customerReference: null,
    orderNo: status === 'Exported' ? '5042' : null,
    exportedAt: null,
    sendStarted,
    lines: [line],
    attempts: [],
    invoices: [],
    revision: 3,
    conflicts: 0,
    etag: '"basis-etag"',
  };
}

function mockApi(current: Basis) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? new Response(JSON.stringify({ ...current, status: 'Exported', orderNo: '77001' }), { status: 200 }) : new Response(JSON.stringify(current), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const finance = testUser(['billing.read', 'billing.manage', 'finance.read']);
const show = () => renderRoutes([{ path: '/billing/bases/:id', element: <BillingBasisPage /> }], '/billing/bases/b1', finance);

afterEach(() => vi.unstubAllGlobals());

const openedDialog = () => screen.findByRole('dialog');


describe('BillingBasisPage', () => {
  it('holds a basis whose send got no answer for reconciliation and records the order Finance found', async () => {
    const fetch = mockApi(basis('ReconciliationRequired', true));
    const user = userEvent.setup();
    show();

    expect(await screen.findByText(/A send to PowerOffice got no answer/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel basis' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    const dialog = await openedDialog();
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Order' }), '77001');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Funnet i PowerOffice');
    await user.click(save);

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/v1/billing/bases/b1/reconcile');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ created: true, orderNo: '77001', reason: 'Funnet i PowerOffice' });
    expect((post[1]!.headers as Record<string, string>)['If-Match']).toBe('"basis-etag"');
  });

  it('records that no order exists without asking for a number', async () => {
    const fetch = mockApi(basis('ReconciliationRequired', true));
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByRole('button', { name: 'Reconcile' }));
    const dialog = await openedDialog();
    await user.click(within(dialog).getByRole('radio', { name: 'There is no order' }));
    expect(within(dialog).queryByRole('textbox', { name: 'Order' })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Ingen ordre');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ created: false, orderNo: null, reason: 'Ingen ordre' });
  });

  it('does not offer to cancel a basis while its order is being sent', async () => {
    mockApi(basis('Approved', true));
    show();

    expect(await screen.findByText(/The order is being sent to PowerOffice/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel basis' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument();
  });

  it('offers to cancel a failed basis that was never sent, or to record the order made by hand', async () => {
    const fetch = mockApi(basis('Failed', false));
    const user = userEvent.setup();
    show();

    expect(await screen.findByRole('button', { name: 'Cancel basis' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record a manual order' }));
    const dialog = await openedDialog();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Order' }), 'manual-2032-09');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Fakturert manuelt');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ created: true, orderNo: 'manual-2032-09', reason: 'Fakturert manuelt' });
  });

  it('corrects an exported line with a positive amount queued for the next run', async () => {
    const fetch = mockApi(basis('Exported', true));
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByRole('button', { name: `Add a correction to ${line.description}` }));
    const dialog = await openedDialog();
    const submit = within(dialog).getByRole('button', { name: 'Queue for the next run' });
    await user.type(within(dialog).getByRole('textbox', { name: /Amount to add/ }), '-500');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Rabatt');
    expect(submit).toBeDisabled();

    await user.clear(within(dialog).getByRole('textbox', { name: /Amount to add/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Amount to add/ }), '500');
    await user.click(submit);

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/v1/billing/bases/b1/lines/l1/corrections');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ amount: 500, reason: 'Rabatt', description: null });
  });

  it('shows no correction to a user without billing.manage', async () => {
    mockApi(basis('Exported', true));
    renderRoutes([{ path: '/billing/bases/:id', element: <BillingBasisPage /> }], '/billing/bases/b1', testUser(['billing.read', 'finance.read']));

    await screen.findByText(line.description);
    expect(screen.queryByRole('button', { name: /Add a correction/ })).not.toBeInTheDocument();
  });
});
