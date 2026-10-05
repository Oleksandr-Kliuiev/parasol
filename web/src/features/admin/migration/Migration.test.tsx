import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../../i18n';
import { renderRoutes, testUser } from '../../../test/renderWithProviders';
import { MigrationPage } from '../MigrationPage';
import { ResultView } from './ResultView';
import type { MigrationResult } from './api';
import { reasonText } from './text';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const result = (over: Partial<MigrationResult> = {}): MigrationResult => ({
  created: 1,
  updated: 0,
  unchanged: 0,
  contacts: 1,
  conflicts: 1,
  failed: 1,
  rows: [
    { line: 2, name: 'Acme AS', orgNumber: '923456789', action: 'Created', detail: null, organizationId: null, reasonCode: null, fieldsChanged: null, conflictFields: null, warnings: ['NEAR_DUPLICATE'], contactAction: null },
    { line: 3, name: null, orgNumber: null, action: 'Conflict', detail: 'FIELD_CONFLICT', organizationId: null, reasonCode: 'FIELD_CONFLICT', fieldsChanged: null, conflictFields: ['phone'], warnings: null, contactAction: null },
    { line: 4, name: null, orgNumber: null, action: 'Rejected', detail: 'SOME_NEW_CODE', organizationId: null, reasonCode: 'SOME_NEW_CODE', fieldsChanged: null, conflictFields: null, warnings: null, contactAction: null },
  ],
  warnings: ["Column 'Notes': COLUMN_IGNORED", 'Row 2: NEAR_DUPLICATE'],
  runId: 'r1',
  sourceSha256: 'abcdef0123456789',
  mappingVersion: 'v1',
  repeatKey: 'k',
  mode: 'DryRun',
  status: 'Completed',
  rowsTotal: 3,
  rejected: 1,
  lastCommittedLine: 0,
  reasonCounts: { FIELD_CONFLICT: 1, SOME_NEW_CODE: 1, INVALID_ORGNR: 2 },
  warningCounts: { NEAR_DUPLICATE: 1 },
  owners: { columnPresent: true, resolved: 1, empty: 1, unknown: 1 },
  validatedNotImported: { contractstart: 2 },
  failedFromLine: null,
  failedToLine: null,
  failureCode: null,
  repeated: false,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('reason codes', () => {
  it('are translated and an unknown code falls back to the code', async () => {
    await i18n.changeLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(reasonText(t, 'INVALID_ORGNR')).toBe('The organization number is not valid.');
    expect(reasonText(t, 'SOME_NEW_CODE')).toBe('SOME_NEW_CODE');
  });
});

describe('migration result', () => {
  it('shows counts with rejected and conflicts, the reason breakdown, owners and validated-only columns', () => {
    renderRoutes([{ path: '*', element: <ResultView result={result()} /> }], '/');

    expect(screen.getByText('Conflicts').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Rejected', { selector: 'dt' }).nextSibling).toHaveTextContent('1');
    expect(screen.getByText(/The organization number is not valid\./)).toBeInTheDocument();
    expect(screen.getByText(/rows name a known owner/)).toBeInTheDocument();
    expect(screen.getByText(/Contract start/)).toBeInTheDocument();
    expect(screen.getByText(/Column “Notes” is not used\./)).toBeInTheDocument();
    expect(screen.getByText('The CRM holds a different value than the file. The CRM value is kept.', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('SOME_NEW_CODE', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Different in the CRM (kept): phone')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Rows that change something or need attention' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/3 of 3 rows/)).toBeInTheDocument();
  });

  it('explains a repeated run', () => {
    renderRoutes([{ path: '*', element: <ResultView result={result({ mode: 'Real', repeated: true })} /> }], '/');
    expect(screen.getByText(/already imported/)).toBeInTheDocument();
  });

  it('says where a partial run stopped and continues with the same file', async () => {
    const onContinue = vi.fn();
    renderRoutes(
      [{ path: '*', element: <ResultView result={result({ mode: 'Real', status: 'Partial', lastCommittedLine: 40, failedFromLine: 41, failedToLine: 60, failureCode: 'IMPORT_CHUNK_FAILED' })} onContinue={onContinue} /> }],
      '/',
    );
    expect(screen.getByText(/Rows up to line 40 are saved/)).toBeInTheDocument();
    expect(screen.getByText(/Rows 41-60 could not be saved/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue import' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

describe('migration page', () => {
  const setup = (answers: Array<Response | (() => Response)>) => {
    const fetch = vi.fn(async () => {
      const next = answers.shift();
      return typeof next === 'function' ? next() : next!;
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '*', element: <MigrationPage /> }], '/admin/migration', testUser(['customers.delete']));
    return fetch;
  };

  it('enables the import only after a preview of the same text and sends its hash', async () => {
    const fetch = setup([json(result()), json(result()), json(result({ mode: 'Real', created: 1 }))]);
    const user = userEvent.setup();
    const box = screen.getByRole('textbox', { name: 'Or paste the rows' });
    const importButton = screen.getByRole('button', { name: 'Import' });

    fireEvent.change(box, { target: { value: 'Name\nAcme' } });
    expect(importButton).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(importButton).toBeEnabled());

    fireEvent.change(box, { target: { value: 'Name\nAcme 2' } });
    expect(importButton).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Name\nAcme' } });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(importButton).toBeEnabled());
    await user.click(importButton);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[2]![0]).toBe('/api/v1/customers/organizations/import?dryRun=false&expectedSha256=abcdef0123456789');
    expect(calls[2]![1].method).toBe('POST');
  });

  it('tells the user to preview again when the file changed', async () => {
    setup([json(result()), json({ code: 'IMPORT_SOURCE_CHANGED', title: 'IMPORT_SOURCE_CHANGED', status: 409 }, 409)]);
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Or paste the rows' }), { target: { value: 'Name\nAcme' } });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const importButton = screen.getByRole('button', { name: 'Import' });
    await waitFor(() => expect(importButton).toBeEnabled());
    await user.click(importButton);

    expect((await screen.findAllByText('The file changed since the preview. Preview it again.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Preview it again');
    expect(importButton).toBeDisabled();
  });

  it('does not start a second import on a double click', async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => (fetch.mock.calls.length === 1 ? json(result()) : pending));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '*', element: <MigrationPage /> }], '/admin/migration', testUser(['customers.delete']));
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Or paste the rows' }), { target: { value: 'Name\nAcme' } });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const importButton = screen.getByRole('button', { name: 'Import' });
    await waitFor(() => expect(importButton).toBeEnabled());

    fireEvent.click(importButton);
    fireEvent.click(importButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).toHaveBeenCalledTimes(2);
    release(json(result({ mode: 'Real' })));
  });

  it('lists the runs and ends the list with N of M', async () => {
    const run = (id: string) => ({ id, mode: 'Real', status: 'Completed', sourceSha256: 'x', mappingVersion: 'v1', repeatKey: 'k', rowsTotal: 3, created: 1, updated: 1, unchanged: 1, conflicts: 0, rejected: 0, contacts: 0, lastCommittedLine: 3, failedFromLine: null, failedToLine: null, failureCode: null, startedAt: '2026-10-01T10:00:00Z', finishedAt: null, userId: null });
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [run('a'), run('b')], nextCursor: 'c', totalCount: 7 })));
    renderRoutes([{ path: '*', element: <MigrationPage /> }], '/admin/migration?tab=runs', testUser(['customers.delete']));

    expect(await screen.findByRole('region', { name: 'Import runs' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Showing 2 of 7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('hides amounts for a caller without finance.read', async () => {
    const line = { line: 2, orgNumber: '923456789', organizationId: null, period: '2026-09', currency: 'NOK', fileRows: 1, status: 'Compared', reasonCode: null };
    vi.stubGlobal('fetch', vi.fn(async () => json({ sourceSha256: 'x', fileRows: 1, customers: 1, amountsVisible: false, statusCounts: { Compared: 1 }, lines: [line] })));
    renderRoutes([{ path: '*', element: <MigrationPage /> }], '/admin/migration?tab=reconcile', testUser(['customers.delete']));
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Or paste the rows' }), { target: { value: 'orgnr;period;currency;amount\n923456789;2026-09;NOK;100' } });
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    expect(await screen.findByText('You may see the statuses but not the amounts.')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'CRM billed' })).toBeNull();
    expect(screen.getAllByText('Compared').length).toBeGreaterThan(0);
  });
});
