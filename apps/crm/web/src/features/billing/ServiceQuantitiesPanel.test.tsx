import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import i18n from '../../i18n';
import { anomalyText } from './anomalyText';
import { ServiceQuantitiesPanel } from './ServiceQuantitiesPanel';
import type { ServiceQuantities } from './serviceQuantities';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const quantities = (withMoney: boolean): ServiceQuantities => ({
  organizationId: 'o1', asOf: '2026-10-23', staleQuantityDays: 3,
  services: [
    { model: 'PerAteraDevice', source: 'atera', count: 7, detail: { Workstation: 6, Server: 1 }, readOn: '2026-10-23', stale: false, status: 'NotOnContract',
      lines: [], billLines: [] },
    { model: 'PerHuntressAgent', source: 'huntress', count: 21, detail: null, readOn: '2026-10-23', stale: false, status: 'Counted',
      lines: [{ contractId: 'c1', contractNumber: 'K-1001', lineId: 'l1', productName: 'Huntress per agent', deviceFilter: null, estimate: 3, billed: 21,
        validFrom: '2026-01-01', validTo: null }], billLines: [] },
    { model: 'PerBackupSeat', source: 'cloudally', count: 14, detail: null, readOn: '2026-10-18', stale: true, status: 'NoReading', lines: [],
      billLines: [{ day: '2026-10-18', account: 'acc-1', accountName: 'Fjord IT AS', service: 'Exchange', source: 'MS365', seats: 14, accounts: 14,
        ...(withMoney ? { price: 2.5, total: 35 } : {}), currency: 'EUR' }] },
  ],
});

const render = (permissions: string[], withMoney: boolean) => {
  vi.stubGlobal('fetch', vi.fn(async () => json(quantities(withMoney))));
  return renderRoutes([page(<ServiceQuantitiesPanel organizationId="o1" />)], '/', testUser(permissions));
};

describe('ServiceQuantitiesPanel (M43)', () => {
  it('shows each count against the contract, an old count in words, and what CloudAlly bills', async () => {
    render(['billing.read', 'finance.cost.read'], true);
    const panel = await screen.findByRole('region', { name: 'Counted by the services' });
    expect(await within(panel).findByText('Agents in Huntress')).toBeInTheDocument();
    expect(within(panel).getByText('Huntress per agent · contract K-1001: the estimate is 3, the next basis bills 21')).toBeInTheDocument();
    expect(within(panel).getByText('Billed by the count')).toBeInTheDocument();
    expect(within(panel).getByText('No contract line bills it')).toBeInTheDocument();
    expect(within(panel).getByText(/older than 3 days/)).toBeInTheDocument();
    expect(within(panel).getByText(/Workstations 6 · Servers 1/)).toBeInTheDocument();
    // One account: named once above the table, not in every row.
    expect(within(panel).getByText('Bill of 18/10/2026 for the account Fjord IT AS')).toBeInTheDocument();
    const bill = within(panel).getByRole('table', { name: 'What CloudAlly bills' });
    expect(within(bill).queryByRole('columnheader', { name: 'Account' })).toBeNull();
    expect(within(bill).getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();
  });

  it('names the account in each row when the customer has more than one', async () => {
    const two = quantities(true);
    const backup = two.services[2]!;
    two.services[2] = { ...backup, billLines: [...backup.billLines, { ...backup.billLines[0]!, account: 'acc-2', accountName: 'Fjord IT Bergen' }] };
    vi.stubGlobal('fetch', vi.fn(async () => json(two)));
    renderRoutes([page(<ServiceQuantitiesPanel organizationId="o1" />)], '/', testUser(['billing.read', 'finance.cost.read']));
    const bill = await screen.findByRole('table', { name: 'What CloudAlly bills' });
    expect(within(bill).getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(within(bill).getByText('Fjord IT Bergen')).toBeInTheDocument();
    expect(screen.getByText('Bill of 18/10/2026')).toBeInTheDocument();
  });

  it('leaves out the money of the bill for a reader without purchase prices, and says so', async () => {
    render(['billing.read'], false);
    const panel = await screen.findByRole('region', { name: 'Counted by the services' });
    const bill = await within(panel).findByRole('table', { name: 'What CloudAlly bills' });
    expect(within(bill).queryByRole('columnheader', { name: 'Price' })).toBeNull();
    expect(within(panel).getByText(/The amounts are shown to those who see purchase prices./)).toBeInTheDocument();
  });

  it('words a missing Huntress or CloudAlly count in the reader’s language', () => {
    const t = i18n.getFixedT('en');
    expect(anomalyText(t, { code: 'BIL_NO_AGENT_READING', message: 'x', args: { product: 'Huntress per agent' } }))
      .toBe('Huntress per agent is billed per Huntress agent, but Huntress has not counted them for the customer yet; the contract’s estimate is billed.');
    expect(anomalyText(t, { code: 'BIL_NO_SEAT_READING', message: 'x', args: { product: 'Backup', subsidiary: 'Datter AS' } })).toMatch(/^Datter AS: Backup is billed per backup user/);
  });
});
