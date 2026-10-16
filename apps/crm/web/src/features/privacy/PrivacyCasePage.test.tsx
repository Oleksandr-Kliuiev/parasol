import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { HistoryList } from '../audit/HistoryList';
import type { Plan, PrivacyCase } from './api';
import { NewPrivacyCasePage } from './NewPrivacyCasePage';
import { PrivacyCasePage } from './PrivacyCasePage';

const contactId = '11111111-2222-4333-8444-555555555555';
const quoteId = '66666666-7777-4888-9999-000000000000';
const activityId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

const privacyCase = (overrides: Partial<PrivacyCase> = {}): PrivacyCase => ({
  id: 'c1', number: 'PRV-2026-0007', kind: 'Erasure', subjectKind: 'Contact', subjectId: contactId, status: 'Previewed',
  receivedAt: '2026-10-01T09:00:00Z', dueOn: '2026-11-01', overdue: false, channel: 'Email', note: null,
  verifiedAt: '2026-10-02T09:00:00Z', verificationMethod: 'KnownEmail', verificationNote: null, planDigest: 'digest-1',
  previewedAt: '2026-10-03T09:00:00Z', completedAt: null, rejectionReason: null, exportSha256: null, receipt: null, etag: '"5"',
  ...overrides,
});

const plan: Plan = {
  digest: 'digest-1',
  records: [
    { record: { module: 'customers', entityType: 'Contact', entityId: contactId }, action: 'Pseudonymize', dataClass: 'customers.contact', basis: null, retainUntil: null, note: null },
    { record: { module: 'sales', entityType: 'Quote', entityId: quoteId }, action: 'Retain', dataClass: 'sales.accepted-quote', basis: 'Bookkeeping', retainUntil: '2031-12-31', note: 'Accepted quote' },
  ],
  counts: [
    { module: 'customers', action: 'Pseudonymize', records: 1 },
    { module: 'sales', action: 'Retain', records: 1 },
  ],
  etag: '"5"',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('Privacy case (DEV-11)', () => {
  it('carries out the previewed plan only after the case number is typed, with the version and digest it showed', async () => {
    let current = privacyCase();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/privacy/cases/c1/execute' && init?.method === 'POST') {
        current = privacyCase({ status: 'Completed', completedAt: '2026-10-04T10:00:00Z', etag: '"6"' });
        return json(current);
      }
      if (url === '/api/v1/privacy/cases/c1/plan') return json(plan);
      if (url === '/api/v1/privacy/cases/c1') return json(current);
      return json([]);
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '/admin/privacy/cases/:id', element: <PrivacyCasePage /> }], '/admin/privacy/cases/c1', testUser(['privacy.manage']));

    const counts = await screen.findByRole('table', { name: 'Plan per module' });
    expect(within(counts).getByText('Pseudonymize')).toBeInTheDocument();
    const records = screen.getByRole('table', { name: 'Records in the plan' });
    expect(within(records).getByText('Bookkeeping Act')).toBeInTheDocument();
    expect(within(records).getByText('Accepted quote')).toBeInTheDocument();
    // A kept record needs no hold; the others can get one before the erasure.
    expect(screen.getByRole('button', { name: 'Place a legal hold on Contact person 11111111' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Place a legal hold on Quote/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Carry out the erasure' }));
    const dialog = await screen.findByRole('dialog', { name: 'Carry out erasure PRV-2026-0007' });
    const erase = within(dialog).getByRole('button', { name: 'Erase' });
    expect(erase).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /Type the request number/ }), 'PRV-2026-000');
    expect(erase).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /Type the request number/ }), '7');
    await user.click(erase);

    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/privacy/cases/c1/execute')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/privacy/cases/c1/execute')!;
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['If-Match']).toBe('"5"');
    expect((init!.headers as Record<string, string>)['X-CSRF']).toBe('1');
    expect(JSON.parse(init!.body as string)).toEqual({ planDigest: 'digest-1', confirmation: 'PRV-2026-0007' });
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  it('shows the receipt of a completed erasure: what was kept, the suppressions and the systems to erase by hand', async () => {
    const completed = privacyCase({
      status: 'Completed',
      completedAt: '2026-10-04T10:00:00Z',
      receipt: {
        case: 'PRV-2026-0007', manifest: 'm1', manifestSha256: 'ab'.repeat(32),
        modules: [{ module: 'customers', actions: [{ action: 'Pseudonymize', records: 1 }, { action: 'Delete', records: 2 }] }],
        retained: [
          { module: 'sales', entityType: 'Quote', entityId: quoteId, basis: 'Bookkeeping', until: '2031-12-31', note: null },
          { module: 'activities', entityType: 'Activity', entityId: activityId, basis: 'LegalHold', until: '2027-06-30', note: 'Dispute' },
        ],
        operatorErasure: [{ module: 'sales', entityType: 'QuoteDocument', records: 1 }],
        suppressions: [{ kind: 'Email', count: 1 }, { kind: 'ExternalReference', count: 1 }],
        externalSystems: ['atera'],
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/v1/privacy/cases/c1' ? completed : plan)));
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        { path: '/admin/privacy/cases/:id', element: <PrivacyCasePage /> },
        { path: '/admin/privacy/new', element: <NewPrivacyCasePage /> },
      ],
      '/admin/privacy/cases/c1',
      testUser(['privacy.manage']),
    );

    expect(await screen.findByRole('table', { name: 'Done per module' })).toHaveTextContent('Pseudonymize: 1 · Delete: 2');
    expect(screen.getByRole('table', { name: 'Kept' })).toHaveTextContent('Quote 66666666');
    expect(screen.getByText('2 suppressions keep the person from being imported again.')).toBeInTheDocument();
    expect(screen.getByText(/Stored quote documents are erased by the database operator/)).toBeInTheDocument();
    expect(screen.getByText(/The person may still exist in Atera/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carry out the erasure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

    // What a hold kept is erased by a new request for the same person once the hold has ended.
    await user.click(screen.getByRole('button', { name: 'New erasure request' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/privacy/new'));
    expect(router.state.location.search).toBe(`?subjectKind=Contact&subjectId=${contactId}&kind=Erasure`);
    expect(screen.getByText('The person of request PRV-2026-0007')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Erasure:/ })).toBeChecked();
  });

  it('is not there for a user without the privacy permission', async () => {
    const fetch = vi.fn(async () => json(privacyCase()));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '/admin/privacy/cases/:id', element: <PrivacyCasePage /> }], '/admin/privacy/cases/c1', testUser(['customers.read', 'audit.read']));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('New privacy case (DEV-11)', () => {
  it('opens the request for the person it was started from and goes to it', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url === '/api/v1/privacy/cases' && init?.method === 'POST' ? json(privacyCase({ id: 'c9', status: 'Received' }), 201) : json(privacyCase({ id: 'c9' })));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        { path: '/admin/privacy/new', element: <NewPrivacyCasePage /> },
        { path: '/admin/privacy/cases/:id', element: <p>case page</p> },
      ],
      `/admin/privacy/new?subjectKind=Contact&subjectId=${contactId}`,
      testUser(['privacy.manage']),
    );

    await user.click(await screen.findByRole('radio', { name: /Erasure: remove what the CRM has no reason to keep/ }));
    await user.click(screen.getByRole('button', { name: 'Open the request' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/privacy/cases/c9'));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/privacy/cases')!;
    expect(JSON.parse(init!.body as string)).toEqual({
      kind: 'Erasure', subjectKind: 'Contact', subjectId: contactId, channel: 'Email', receivedAt: null, note: null,
    });
  });

  it('refuses an address that does not name a person', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([])));
    renderRoutes([{ path: '/admin/privacy/new', element: <NewPrivacyCasePage /> }], '/admin/privacy/new?subjectKind=Organization&subjectId=x', testUser(['privacy.manage']));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('History of an erased record (DEV-11-AC02)', () => {
  it('keeps the fact of each change and shows none of the erased details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      items: [
        { id: 2, at: '2026-10-04T10:00:00Z', userId: null, userName: 'Kari Nordmann', action: 'Erase', module: 'customers', entityType: 'Contact', entityId: contactId, changes: { case: 'PRV-2026-0007', fields: ['FirstName'] }, correlationId: null, erased: false },
        { id: 1, at: '2026-10-01T10:00:00Z', userId: null, userName: 'Ola Nordmann', action: 'Update', module: 'customers', entityType: 'Contact', entityId: contactId, changes: null, correlationId: null, erased: true },
      ],
      nextCursor: null,
    })));
    renderRoutes([{ path: '*', element: <HistoryList module="customers" entityType="Contact" entityId={contactId} /> }], '/', testUser(['audit.read']));

    expect(await screen.findByText('erased on request')).toBeInTheDocument();
    expect(screen.getByText('changed')).toBeInTheDocument();
    expect(screen.getByText('Erased on a personal data request; the details are no longer shown.')).toBeInTheDocument();
  });
});
