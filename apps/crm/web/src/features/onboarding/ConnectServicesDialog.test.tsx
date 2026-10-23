import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { dayIn } from '../service/alerts/alertHiding';
import { ConnectServicesDialog } from './ConnectServicesDialog';
import type { CustomerService } from './connectServices';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const services: CustomerService[] = [
  { system: 'atera', kind: 'customer.create', enabled: true, link: null, block: null, simulated: false, defaults: {}, consoleUrl: 'https://app.atera.com/' },
  { system: 'huntress', kind: 'organization.create', enabled: true, link: null, block: null, simulated: false, defaults: { key: 'fjord-it' }, consoleUrl: null },
  { system: 'cloudally', kind: 'account.create', enabled: true, link: null, block: 'VND_KIND_DISABLED', simulated: false, defaults: { region: 'EU', email: null }, consoleUrl: null },
];

const contract = {
  id: 'c1', number: 'K-1001', organization: { id: 'o1', name: 'Fjord IT AS' }, title: 'Drift', type: 'Msp', status: 'Active', startDate: '2026-01-01',
  endDate: null, autoRenew: true, renewalTermMonths: 12, noticePeriodDays: 90, noticeDeadline: null, slaPolicy: null, invoiceFrequency: 'Monthly',
  invoiceTiming: 'InAdvance', priceCategory: null, indexation: false, nextIndexationDate: null, customerReference: null, owner: null, notes: null,
  noticeGivenOn: null, endedOn: null, renewalCount: 0, currency: 'NOK', lines: [], createdAt: '2026-01-01T08:00:00Z', modifiedAt: null,
};

const preview = (system: string, kind: string, effects: { code: string; values: Record<string, string | null> }[]) => ({
  previewToken: `token-${system}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), system, kind, level: 'Standard',
  target: { type: 'organization', id: 'o1', name: 'Fjord IT AS', organizationId: 'o1', organizationName: 'Fjord IT AS', externalCustomerId: null, url: null },
  effects, block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
});

const action = (system: string, kind: string, status: string, outcomeCode: string | null) => ({
  id: `act-${system}`, system, kind, level: 'Standard', targetType: 'organization', targetId: 'o1', targetName: 'Fjord IT AS', organizationId: 'o1',
  organizationName: 'Fjord IT AS', parameters: {}, reason: null, status, outcomeCode, outcome: null, reference: null, attempts: 1, requestedBy: 'u1',
  requestedByName: 'Kari Nordmann', requestedAt: new Date().toISOString(), notBefore: new Date().toISOString(), startedAt: null, completedAt: null,
  closedBy: null, closedByName: null, closedAt: null, closeReason: null, ticketId: null, vendorUrl: null, etag: '"1"',
});

function stub() {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (init?.method === 'POST') posted.push({ url, body });
    if (url === '/api/v1/integrations/organizations/o1/services') return json({ organizationId: 'o1', name: 'Fjord IT AS', services });
    if (url.startsWith('/api/v1/contracts?')) return json({ items: [contract], nextCursor: null, totalCount: 1 });
    if (url === '/api/v1/contracts/c1') return json(contract);
    if (url.startsWith('/api/v1/catalog/products')) {
      return json({ items: [{ id: 'p1', sku: 'HNT-AGENT', name: 'Huntress per agent', type: 'ManagedService', businessLine: 'Security', unit: 'Piece',
        billingPeriod: 'Monthly', listPrice: 60, currency: 'NOK', isActive: true }], nextCursor: null, totalCount: 1 });
    }
    if (url === '/api/v1/actions/preview') {
      return json(body.system === 'atera'
        ? preview('atera', 'customer.create', [{ code: 'VND_EFFECT_ATERA_CUSTOMER_CREATE', values: { name: 'Fjord IT AS', orgNumber: '923609016' } },
          { code: 'VND_EFFECT_CUSTOMER_LINKED', values: { vendor: 'Atera' } }])
        : preview('huntress', 'organization.create', [{ code: 'VND_EFFECT_HUNTRESS_ORGANIZATION_CREATE', values: { name: 'Fjord IT AS', key: String((body.parameters as { key: string }).key) } }]));
    }
    if (url === '/api/v1/actions') return json(action(String(body.system), String(body.kind), 'Queued', null), 202);
    if (url.startsWith('/api/v1/actions/act-')) {
      const system = url.endsWith('atera') ? 'atera' : 'huntress';
      return json(action(system, system === 'atera' ? 'customer.create' : 'organization.create', 'Succeeded', 'VND_CREATED'));
    }
    if (url === '/api/v1/contracts/c1/lines') return json(contract);
    return json({ items: [], nextCursor: null, totalCount: 0 });
  });
  vi.stubGlobal('fetch', fetch);
  return posted;
}

const render = () => renderRoutes([page(<ConnectServicesDialog organizationId="o1" onClose={() => undefined} />)], '/',
  testUser(['integrations.manage', 'contracts.write', 'contracts.read']));

describe('ConnectServicesDialog (M43)', () => {
  it('creates the customer where it can, adds a contract line and says what is left in the consoles', async () => {
    const user = userEvent.setup();
    const posted = stub();
    render();

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Step 1 of 4: Services')).toHaveFocus();
    // CloudAlly cannot be created here: the wizard says why and leads to the mapping screen instead of offering it.
    expect(within(dialog).getByText('Creating customers in CloudAlly is not switched on in this installation.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Link an existing record under Mappings' })).toHaveAttribute('href', '/admin/mappings?system=cloudally&type=Customer');
    expect(within(dialog).getByRole('checkbox', { name: 'Create in Atera' })).toBeChecked();
    const key = within(dialog).getByRole('textbox', { name: /Organization key/ });
    expect(key).toHaveValue('fjord-it');
    await user.clear(key);
    await user.type(key, 'Fjord IT');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Use lower-case letters, digits and hyphens (at most 64 characters).')).toBeInTheDocument();
    await user.clear(key);
    await user.type(key, 'fjord-it');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await within(dialog).findByText('Step 2 of 4: Contract')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bill per Atera device' }));
    await user.type(within(dialog).getByRole('combobox', { name: /^Product/ }), 'HNT');
    await user.click(await screen.findByRole('option', { name: /Huntress per agent/ }));
    const estimate = within(dialog).getByRole('textbox', { name: /Quantity until the first count/ });
    await user.clear(estimate);
    await user.type(estimate, '12');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(await within(dialog).findByText('Huntress gets the organization “Fjord IT AS” with the organization key fjord-it.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Huntress per agent – Per Huntress agent, 12 until the first count/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create and link' }));

    expect(await within(dialog).findByText('Step 4 of 4: Result')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByText('Created and linked to the customer.')).toHaveLength(2));
    expect(within(dialog).getByText('Huntress per agent added')).toBeInTheDocument();
    expect(within(dialog).getByText(/organization key fjord-it/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open Atera' })).toHaveAttribute('href', 'https://app.atera.com/');

    const commands = posted.filter((p) => p.url === '/api/v1/actions');
    expect(commands.map((c) => [c.body.system, c.body.kind, c.body.targetType, c.body.previewToken])).toEqual([
      ['atera', 'customer.create', 'organization', 'token-atera'], ['huntress', 'organization.create', 'organization', 'token-huntress']]);
    expect(commands[1]!.body.parameters).toEqual({ key: 'fjord-it' });
    expect(posted.find((p) => p.url === '/api/v1/contracts/c1/lines')!.body).toEqual({
      productId: 'p1', description: null, quantityModel: 'PerHuntressAgent', deviceFilter: null, quantity: 12, unitPrice: null, discountPct: null,
      validFrom: dayIn(0), validTo: null,
    });
  });
});
