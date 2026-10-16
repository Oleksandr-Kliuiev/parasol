import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { RecordAccessPage, type RecordScopeReport } from './RecordAccessPage';

const report: RecordScopeReport = {
  mode: 'Restricted',
  sections: [
    {
      kind: 'quotes', everyRecordPermission: 'sales.quotes.all', rolesSeeingAll: ['Crm.Admin', 'Crm.Finance', 'Crm.Management'],
      rolesLimited: ['Crm.ReadOnly', 'Crm.Sales', 'Crm.ServiceLead', 'Crm.Technician'], total: 42, withoutAssignee: 3,
      assignees: [
        { userId: 'u1', name: 'Kari Nordmann', active: true, records: 30 },
        { userId: 'u2', name: 'Per Hansen', active: false, records: 9 },
      ],
    },
    {
      kind: 'projects', everyRecordPermission: 'projects.all', rolesSeeingAll: ['Crm.Admin'], rolesLimited: ['Crm.Technician'],
      total: 5, withoutAssignee: 0, assignees: [],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('RecordAccessPage (DEV-09)', () => {
  it('shows the mode, who sees what and how the records are spread over people', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(report), { status: 200 })));
    renderRoutes([{ path: '/admin/record-access', element: <RecordAccessPage /> }], '/admin/record-access', testUser(['audit.read']));

    expect(await screen.findByText('Restricted: the limited roles see only their own or assigned records.')).toBeInTheDocument();
    const quotes = screen.getByRole('region', { name: 'Quotes' });
    expect(within(quotes).getByText('See all: Admin, Finance, Management')).toBeInTheDocument();
    expect(within(quotes).getByText('Only their own or assigned: Read-only, Sales, Service lead, Technician')).toBeInTheDocument();
    expect(within(quotes).getByText('Without owner or assignee: 3 — only the roles that see all of them see these.')).toBeInTheDocument();
    const rows = within(within(quotes).getByRole('table', { name: 'Quotes per person' })).getAllByRole('row');
    expect(rows[2]).toHaveTextContent('Per Hansen · inactive9');
    const projects = screen.getByRole('region', { name: 'Projects' });
    expect(within(projects).getByText('No one owns or is assigned to any of them.')).toBeInTheDocument();
  });

  it('warns when the environment runs with record scope open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...report, mode: 'Open' }), { status: 200 })));
    renderRoutes([{ path: '/admin/record-access', element: <RecordAccessPage /> }], '/admin/record-access', testUser(['audit.read']));

    expect(await screen.findByText('Open: everyone who can read quotes or projects sees all of them.')).toBeInTheDocument();
  });
});
