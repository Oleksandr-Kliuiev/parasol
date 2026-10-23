import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { OrganizationDocumentsTab } from './OrganizationDocumentsTab';
import type { StoredDocument } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const stored = (overrides: Partial<StoredDocument> = {}): StoredDocument => ({
  id: 'd1', kind: 'huntress-monthly', sourceKey: 'huntress:report:9001', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  fileName: 'huntress-2026-09-9001.pdf', length: 245_760, provenance: 'Source', storedAt: '2026-10-01T03:55:00Z', ...overrides,
});

const sharePoint = { available: false, folder: null, items: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show(documents: StoredDocument[], permissions = ['customers.read', 'service.read'], download?: Response) {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/stored-documents/') && url.endsWith('/download')) return download ?? new Response(new Blob(['%PDF-1.4']), { status: 200 });
    if (url.includes('/stored-documents')) return json({ items: documents, nextCursor: null, totalCount: documents.length });
    return json(sharePoint);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<OrganizationDocumentsTab organizationId="o1" />)], '/', testUser(permissions));
  return fetch;
}

describe('Monthly reports among the customer\'s documents (M43)', () => {
  it('lists Huntress\'s report and Parasoll\'s summary by month, with when they were filed, their size and a reconstructed summary marked', async () => {
    const fetch = show([
      stored({ id: 'd2', kind: 'parasoll-monthly', sourceKey: 'parasoll:summary:2026-09', fileName: 'parasoll-2026-09.pdf', length: 3_100, provenance: 'Reconstructed' }),
      stored(),
    ]);
    const list = within(await screen.findByRole('list', { name: 'Monthly reports' }));
    expect(fetch).toHaveBeenCalledWith('/api/v1/customers/organizations/o1/stored-documents', expect.anything());
    expect(list.getByText('Parasoll summary · September 2026')).toBeVisible();
    expect(list.getByText('Huntress report · September 2026')).toBeVisible();
    expect(list.getByText(/240 KB/)).toBeVisible();
    // Only the summary made after the month had closed says so, with why.
    const reconstructed = list.getByText('Reconstructed');
    expect(reconstructed).toHaveAttribute('title', 'Made after the month had closed, from what Parasoll held then.');
    expect(list.getAllByText('Reconstructed')).toHaveLength(1);
    expect(screen.getByText('Each file is checked against the fingerprint it was filed with before it is downloaded.')).toBeVisible();
  });

  it('downloads the stored copy by its own address and keeps the server\'s file name', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-pdf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetch = show([stored()], undefined, new Response(new Blob(['%PDF-1.4']), {
      status: 200, headers: { 'Content-Disposition': 'attachment; filename="huntress-2026-09-9001.pdf"' },
    }));
    await userEvent.click(await screen.findByRole('button', { name: 'Download Huntress report · September 2026' }));
    expect(fetch).toHaveBeenCalledWith('/api/v1/customers/organizations/o1/stored-documents/d1/download', expect.anything());
    expect(create).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says plainly when a download fails, as a damaged copy is never served', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:never');
    show([stored()], undefined, json({ code: 'CUS_DOCUMENT_INTEGRITY' }, 500));
    await userEvent.click(await screen.findByRole('button', { name: 'Download Huntress report · September 2026' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The file could not be downloaded.');
  });

  it('says what comes here before any month is filed', async () => {
    show([]);
    expect(await screen.findByText('No monthly reports are filed yet. They appear here after the first month Parasoll has read.')).toBeVisible();
  });

  it('leaves the reports out for those who may not see the Drift tab', async () => {
    const fetch = show([stored()], ['customers.read']);
    expect(await screen.findByText('SharePoint is not set up for the CRM yet.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Monthly reports' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('stored-documents'))).toBe(false);
  });
});
