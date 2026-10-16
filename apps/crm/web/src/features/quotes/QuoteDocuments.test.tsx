import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { QuotePage } from './QuotePage';
import type { Quote, QuoteDocument } from './types';

const document = (overrides: Partial<QuoteDocument>): QuoteDocument => ({
  revision: 1,
  origin: 'Issued',
  status: 'Ready',
  fileName: 'T-2026-0042.pdf',
  length: 41_250,
  sha256: '3f2a9c0d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a19',
  rendererVersion: 'quote-pdf/2',
  createdAt: '2026-10-04T08:00:00Z',
  readyAt: '2026-10-04T08:00:01Z',
  ...overrides,
});

const quote = (documents: QuoteDocument[], status: Quote['status'] = 'Ready'): Quote => ({
  id: 'q1', number: 'T-2026-0042', rootId: 'q1', versionNo: 1, organization: { id: 'o1', name: 'Havbris AS' }, contactId: null,
  contactName: null, opportunityId: null, opportunityName: null, title: 'Drift', owner: null, language: 'nb', issuedOn: '2026-10-04',
  validUntil: '2026-11-03', termMonths: 12, introText: null, termsText: null, customerReference: null, status, maxDiscountPct: 0,
  discountLimitPct: 15, needsApproval: false, approvalRequestedBy: null, approvalRequestedAt: null, approvedBy: null, approvedAt: null,
  rejectedReason: null, sentAt: null, sentTo: null, decidedOn: null, declineReason: null, isEditable: false, hasDocument: true,
  canSendByEmail: true, oneTimeExVat: 0, oneTimeVat: 0, monthlyExVat: 4_500, monthlyVat: 1_125, contractValue: 54_000,
  lines: [], versions: [{ id: 'q1', versionNo: 1, status, issuedOn: '2026-10-04', sentAt: null }], documents, etag: '"1"',
});

function show(data: Quote) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url === '/api/v1/sales/quotes/q1' ? data : []), { status: 200 })));
  renderRoutes([{ path: '/quotes/:id', element: <QuotePage /> }], '/quotes/q1', testUser(['sales.read', 'sales.write', 'finance.read']));
}

afterEach(() => vi.unstubAllGlobals());

describe('Quote documents (DEV-08)', () => {
  it('holds the quote back while its document is being stored', async () => {
    show(quote([document({ status: 'Preparing', sha256: null, length: null, readyAt: null })]));

    expect(await screen.findByText(/The document of this version is being stored/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(/Revision 1 · issued at release · being stored/)).toBeInTheDocument();
  });

  it('lists each stored revision with its hash and labels a reconstructed copy', async () => {
    show(quote([document({ origin: 'Reconstructed', fileName: 'T-2026-0042-gjenskapt.pdf' }), document({ revision: 2 })], 'Sent'));

    expect(await screen.findByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', '/api/v1/sales/quotes/q1/pdf');
    expect(screen.getByText(/Revision 1 · reconstructed · stored/)).toBeInTheDocument();
    expect(screen.getByText(/is not the document that was sent/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download revision 2' })).toHaveAttribute('href', '/api/v1/sales/quotes/q1/pdf?revision=2');
    expect(screen.getAllByText('SHA-256 3f2a9c0d8e7b6a5f…')).toHaveLength(2);
  });
});
