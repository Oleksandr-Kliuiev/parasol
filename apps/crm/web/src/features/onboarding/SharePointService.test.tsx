import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import type { VendorAction } from '../actions/types';
import { ConnectResult } from './ConnectResult';
import { ServiceChoices } from './ServiceChoices';
import { initialChoice, type CustomerService } from './connectServices';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

const sharePoint = (changes: Partial<CustomerService> = {}): CustomerService => ({
  system: 'graph', kind: 'folder.create', enabled: true, link: null, block: null, simulated: false,
  defaults: { name: 'Fjord IT AS (923609016)', root: 'Kunder' }, consoleUrl: null, ...changes,
});

const created = (system: string, kind: string): VendorAction => ({
  id: `act-${system}`, system, kind, level: 'Standard', targetType: 'organization', targetId: 'o1', targetName: 'Fjord IT AS', organizationId: 'o1',
  organizationName: 'Fjord IT AS', parameters: {}, reason: null, status: 'Succeeded', outcomeCode: 'VND_CREATED', outcome: null, reference: null,
  attempts: 1, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-11-02T12:00:00Z', notBefore: '2026-11-02T12:00:00Z',
  startedAt: null, completedAt: '2026-11-02T12:00:03Z', closedBy: null, closedByName: null, closedAt: null, closeReason: null, ticketId: null,
  vendorUrl: null, etag: '"1"',
});

describe('SharePoint in "Connect services" (M47)', () => {
  it.each([
    // "in the folder “Kunder”", never a bare "in Kunder" that reads as the app's own section.
    ['Kunder', 'The folder “Fjord IT AS (923609016)” is created in the folder “Kunder” and linked to the customer.'],
    ['', 'The folder “Fjord IT AS (923609016)” is created in the document library and linked to the customer.'],
  ])('says what the folder is called and where it is made (root folder "%s")', (root, note) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    const services = [sharePoint({ defaults: { name: 'Fjord IT AS (923609016)', root } })];
    renderRoutes([page(<ServiceChoices services={services} choices={services.map(initialChoice)} touched={false} onChange={() => undefined} />)], '/',
      testUser(['integrations.manage']));

    const create = screen.getByRole('checkbox', { name: 'Create in SharePoint' });
    expect(create).toBeChecked();
    expect(screen.getByText(note)).toBeVisible();
    expect(create).toHaveAccessibleDescription(note);
  });

  it('leads a refused folder to the SharePoint folders on the mapping screen', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    const services = [sharePoint({ block: 'VND_KIND_DISABLED' })];
    renderRoutes([page(<ServiceChoices services={services} choices={services.map(initialChoice)} touched={false} onChange={() => undefined} />)], '/',
      testUser(['integrations.manage']));

    // SharePoint makes the customer's folder, not a customer: the code is worded for it.
    expect(screen.getByText('Creating folders in SharePoint is not switched on in this installation.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Link an existing record under Mappings' })).toHaveAttribute('href', '/admin/mappings?system=graph&type=Folder');
  });

  it('leads a folder named like the customer to the mapping screen searched for that folder', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    const services = [sharePoint({ block: 'VND_EXISTS_AT_VENDOR', existing: 'Fjord IT' })];
    renderRoutes([page(<ServiceChoices services={services} choices={services.map(initialChoice)} touched={false} onChange={() => undefined} />)], '/',
      testUser(['integrations.manage']));

    expect(screen.getByText('SharePoint already has the folder “Fjord IT”, not linked to any customer. Link it under Mappings instead.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Link an existing record under Mappings' }))
      .toHaveAttribute('href', '/admin/mappings?system=graph&type=Folder&search=Fjord%20IT');
  });

  it('names nothing left to do outside Parasoll for a folder that was made', () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('act-atera') ? created('atera', 'customer.create') : created('graph', 'folder.create'))));
    renderRoutes([page(
      <ConnectResult
        creates={[{ system: 'atera', action: created('atera', 'customer.create'), error: null }, { system: 'graph', action: created('graph', 'folder.create'), error: null }]}
        lines={[]} contractId={null} contractNumber={null} choices={[]} onSettled={() => undefined}
        services={[sharePoint(), { ...sharePoint(), system: 'atera', kind: 'customer.create', defaults: {} }]}
      />,
    )], '/', testUser(['integrations.manage']));

    const next = screen.getByRole('region', { name: 'Left to do outside Parasoll' });
    expect(next).toHaveTextContent('Install the Atera agent');
    expect(next).not.toHaveTextContent('SharePoint');
  });
});
