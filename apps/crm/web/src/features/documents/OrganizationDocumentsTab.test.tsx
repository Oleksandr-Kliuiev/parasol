import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import type { ActionPreview, VendorAction } from '../actions/types';
import { OrganizationDocumentsTab } from './OrganizationDocumentsTab';
import type { DocumentFolderState, OrganizationDocuments } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const documents = (state: DocumentFolderState, changes: Partial<OrganizationDocuments> = {}): OrganizationDocuments => ({
  available: true, state, linkId: state === 'NoFolder' ? null : 'l1', folder: null, items: [], more: false, ...changes,
});

const ready = documents('Ready', {
  folder: { folderId: 'f1', name: 'Fjord IT AS (999888777)', webUrl: 'https://vardahei.sharepoint.com/Kunder/Fjord' },
  items: [
    { id: 'i1', name: 'Avtaler', isFolder: true, size: null, modifiedAt: '2026-10-30T10:00:00Z', modifiedBy: 'Kari Nordmann', webUrl: 'https://vardahei.sharepoint.com/Kunder/Fjord/Avtaler' },
    { id: 'i2', name: 'Nettverk.vsdx', isFolder: false, size: 2_048, modifiedAt: '2026-10-29T10:00:00Z', modifiedBy: null, webUrl: 'https://vardahei.sharepoint.com/Kunder/Fjord/Nettverk.vsdx' },
  ],
  more: true,
});

const preview: ActionPreview = {
  previewToken: 'signed-token', expiresAt: '2026-11-02T12:10:00Z', system: 'graph', kind: 'folder.create', level: 'Standard',
  target: { type: 'organization', id: 'o1', name: 'Fjord IT AS', organizationId: 'o1', organizationName: 'Fjord IT AS', externalCustomerId: null, url: null },
  effects: [
    { code: 'VND_EFFECT_SHAREPOINT_FOLDER_CREATE', values: { name: 'Fjord IT AS (999888777)', root: '' } },
    { code: 'VND_EFFECT_CUSTOMER_LINKED', values: { vendor: 'SharePoint' } },
  ],
  block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
};

const action = (changes: Partial<VendorAction> = {}): VendorAction => ({
  id: 'a1', system: 'graph', kind: 'folder.create', level: 'Standard', targetType: 'organization', targetId: 'o1', targetName: 'Fjord IT AS',
  organizationId: 'o1', organizationName: 'Fjord IT AS', parameters: {}, reason: null, status: 'Queued', outcomeCode: null, outcome: null, reference: null,
  attempts: 0, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-11-02T12:00:00Z', notBefore: '2026-11-02T12:00:00Z',
  startedAt: null, completedAt: null, closedBy: null, closedByName: null, closedAt: null, closeReason: null, ticketId: null, vendorUrl: null,
  etag: '"v1"', ...changes,
});

const folderKind = { system: 'graph', kind: 'folder.create', targetType: 'organization', level: 'Standard', simulated: false, limitedToCustomers: false };

afterEach(() => vi.unstubAllGlobals());

/** The tab of customer o1 for a person with these rights; each read of the folder answers the next of `answers` (the last one repeats). */
function show(answers: OrganizationDocuments[], permissions = ['customers.read', 'integrations.manage'], kinds: unknown[] = [folderKind]) {
  let reads = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/customers/organizations/o1/documents') return json(answers[Math.min(reads++, answers.length - 1)]);
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds);
    if (url === '/api/v1/actions/preview') return json(preview);
    if (url === '/api/v1/actions' && init?.method === 'POST') return json(action(), 202);
    if (url === '/api/v1/actions/a1') return json(action({ status: 'Succeeded', outcomeCode: 'VND_CREATED', outcome: 'Created.', completedAt: '2026-11-02T12:00:03Z' }));
    if (url === '/api/v1/integrations/links/l1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<OrganizationDocumentsTab organizationId="o1" organizationName="Fjord IT AS" />)], '/', testUser(permissions));
  return { fetch, reads: () => reads };
}

const calls = (fetch: ReturnType<typeof vi.fn>, method: string) =>
  fetch.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method).map(([url]) => String(url));

describe('The customer\'s SharePoint folder (M47)', () => {
  it('lists the folder, links into SharePoint and says when it holds more than the first page', async () => {
    show([ready]);
    const table = within(await screen.findByRole('table', { name: 'Documents in SharePoint' }));
    expect(screen.getByText('Fjord IT AS (999888777)')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open in SharePoint (opens in a new tab)' })).toHaveAttribute('href', 'https://vardahei.sharepoint.com/Kunder/Fjord');
    // A folder and a file are told apart in words too, and both say they open a new tab (WCAG 1.3.1).
    expect(table.getByRole('link', { name: 'Avtaler, folder (opens in a new tab)' })).toHaveAttribute('target', '_blank');
    expect(table.getByRole('link', { name: 'Nettverk.vsdx (opens in a new tab)' })).toBeVisible();
    expect(table.getByText('2 KB')).toBeVisible();
    // No silent cut: the rest is in SharePoint, and the way there is beside the words.
    expect(screen.getByText('Showing the first 2 items. Open the folder in SharePoint to see the rest.')).toBeVisible();
  });

  it('offers to create the folder through the confirmed action, keeps the dialog while the folder appears and reads the folder again', async () => {
    const { fetch } = show([documents('NoFolder'), ready]);
    const user = userEvent.setup();

    expect(await screen.findByText('The customer is not linked to a folder yet.')).toBeVisible();
    // The words wait for whether creating is switched on, so they never say "not switched on" on the way.
    expect(screen.queryByText(/is not switched on/)).not.toBeInTheDocument();
    expect(await screen.findByText('If the customer already has a folder in SharePoint, link it. Otherwise, create a new one.')).toBeVisible();
    // Linking an old folder comes first, and the mapping screen opens searched for the customer's name without its company form.
    const ways = screen.getAllByRole('link').concat(screen.getAllByRole('button')).filter((way) => /Link an existing folder|Create folder/.test(way.textContent ?? ''));
    expect(ways.map((way) => way.textContent)).toEqual(['Link an existing folder', 'Create folder']);
    expect(screen.getByRole('link', { name: 'Link an existing folder' })).toHaveAttribute('href', '/admin/mappings?system=graph&type=Folder&search=Fjord%20IT');
    await user.click(await screen.findByRole('button', { name: 'Create folder' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Create a folder in SharePoint' }));
    // No root folder configured: the folder is made at the top of the library, and the preview says so in words.
    expect(await dialog.findByText('SharePoint gets the folder “Fjord IT AS (999888777)” in the document library.')).toBeVisible();
    // A folder named another way is not found by the server: the way to link it is offered before anything is made.
    expect(dialog.getByText(/Does the customer already have a folder, perhaps under another name\? Link it instead\./)).toBeVisible();
    expect(dialog.getByRole('link', { name: 'Link an existing folder' })).toHaveAttribute('href', '/admin/mappings?system=graph&type=Folder&search=Fjord%20IT');
    expect(JSON.parse(String(fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')![1]!.body))).toEqual({
      system: 'graph', kind: 'folder.create', targetType: 'organization', targetId: 'o1', parameters: {},
    });
    await user.click(dialog.getByRole('button', { name: 'Create folder' }));

    expect(await dialog.findByText('Created and linked to the customer.', {}, { timeout: 6_000 })).toBeVisible();
    // The tab behind the open dialog (hidden from the tree while it is open) shows the folder, and the dialog stays with its outcome.
    expect(await screen.findByRole('table', { name: 'Documents in SharePoint', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Create a folder in SharePoint' })).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('table', { name: 'Documents in SharePoint' })).toBeInTheDocument();
    // The button that opened the dialog went with the state: the folder's name takes the focus.
    await waitFor(() => expect(screen.getByText('Fjord IT AS (999888777)')).toHaveFocus());
    expect(calls(fetch, 'POST')).toEqual(['/api/v1/actions/preview', '/api/v1/actions']);
  }, 15_000);

  it('leads to the mapping screen alone where creating folders is not switched on', async () => {
    show([documents('NoFolder')], ['customers.read', 'integrations.manage'], []);
    expect(await screen.findByText('If the customer already has a folder in SharePoint, link it. Creating folders from Parasoll is not switched on.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Link an existing folder' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create folder' })).not.toBeInTheDocument();
  });

  it('offers nothing to a person who does not manage the integrations, says who can, and asks nothing about the actions', async () => {
    const { fetch } = show([documents('NoFolder')], ['customers.read']);
    expect(await screen.findByText('Whoever manages the integrations in Parasoll can create a folder or link the customer to one that exists.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(calls(fetch, 'GET').some((url) => url.startsWith('/api/v1/actions'))).toBe(false);
  });

  it('takes the link to a deleted folder off after asking, deletes nothing in SharePoint, and reads the folder again', async () => {
    const { fetch } = show([documents('Gone'), documents('NoFolder')]);
    const user = userEvent.setup();

    expect(await screen.findByText('The folder the customer is linked to was deleted or moved in SharePoint.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove the link' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Remove the link to the folder?' }));
    expect(dialog.getByText(/Nothing is deleted in SharePoint/)).toBeVisible();
    // The way out takes the focus, so a stray Enter changes nothing.
    expect(dialog.getByRole('button', { name: 'Keep the link' })).toHaveFocus();
    await user.click(dialog.getByRole('button', { name: 'Remove the link' }));

    expect(await screen.findByText('The customer is not linked to a folder yet.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls(fetch, 'DELETE')).toEqual(['/api/v1/integrations/links/l1']);
    // The button that was used went with the state: the words of the new one take the focus.
    await waitFor(() => expect(screen.getByText('The customer is not linked to a folder yet.')).toHaveFocus());
  });

  it('says who can take the link off to a person who may not', async () => {
    show([documents('Gone')], ['customers.read']);
    expect(await screen.findByText('Whoever manages the integrations in Parasoll can remove the link and give the customer a new folder.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove the link' })).not.toBeInTheDocument();
  });

  it('says a folder is out of reach without claiming it is there, and who gives access', async () => {
    show([documents('NoAccess')]);
    expect(await screen.findByText('SharePoint does not let you open the folder.')).toBeVisible();
    expect(screen.getByText('Parasoll shows only what you can open in SharePoint yourself. Ask whoever manages SharePoint for access.')).toBeVisible();
    expect(screen.queryByText('The customer is not linked to a folder yet.')).not.toBeInTheDocument();
  });

  it('says Parasoll cannot read SharePoint for this person, offers a new sign-in and says what else fixes it', async () => {
    show([documents('NotConnected')]);
    expect(await screen.findByText('Parasoll cannot read SharePoint for you.')).toBeVisible();
    expect(screen.getByText(/If signing in again does not help, an administrator has to give Parasoll access/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/bff/login?returnUrl=%2F');
  });

  it('reads the folder again when SharePoint did not answer, and the answer takes the focus', async () => {
    const { reads } = show([documents('Unavailable'), ready]);
    const user = userEvent.setup();
    expect(await screen.findByText('SharePoint did not answer. Try again in a moment.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Documents in SharePoint' })).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(screen.getByText('Fjord IT AS (999888777)')).toHaveFocus());
  });

  it('lists the items on a phone with their facts under the name instead of a table cut to the names', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 600px)', media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    show([ready]);
    const list = within(await screen.findByRole('list', { name: 'Documents in SharePoint' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const [folderRow, fileRow] = list.getAllByRole('listitem');
    expect(within(folderRow!).getByRole('link', { name: 'Avtaler, folder (opens in a new tab)' })).toBeVisible();
    expect(folderRow).toHaveTextContent('Kari Nordmann · 30/10/2026');
    expect(fileRow).toHaveTextContent('2 KB · 29/10/2026');
  });

  it('says SharePoint is not set up when the installation has none', async () => {
    show([{ available: false, state: 'NoFolder', linkId: null, folder: null, items: [], more: false }]);
    expect(await screen.findByText('SharePoint is not set up for the CRM yet.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
