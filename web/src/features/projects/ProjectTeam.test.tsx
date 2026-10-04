import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { ProjectPage } from './ProjectPage';
import { ProjectsPage } from './ProjectsPage';
import type { Project } from './types';

const project: Project = {
  id: 'p1', number: 'P-2026-0007', name: 'Microsoft 365-migrering', organization: { id: 'o1', name: 'Havbris AS' }, type: 'M365Migration',
  status: 'Active', billingModel: 'TimeAndMaterial', manager: { id: 'u9', name: 'Lise Leder' }, startDate: '2026-10-01', endDate: null,
  completedOn: null, contractId: null, opportunityId: null, notes: null,
  progress: { budgetHours: 40, hours: 6, billableHours: 6, phasesDone: 0, phases: 0, openTasks: 0 }, phases: [],
  members: [{ id: 'u3', name: 'Tor Tekniker' }], etag: '"3"',
};

function stub() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') return new Response(JSON.stringify(project), { status: 200 });
    if (url.startsWith('/api/v1/identity/users')) {
      return new Response(JSON.stringify([{ id: 'u4', displayName: 'Ola Olsen', email: null, isActive: true }]), { status: 200 });
    }
    return new Response(JSON.stringify(url === '/api/v1/projects/p1' ? project : []), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('Project team (DEV-09)', () => {
  it('lists the team and lets those who change projects add and remove people', async () => {
    const fetch = stub();
    const user = userEvent.setup();
    renderRoutes([{ path: '/projects/:id', element: <ProjectPage /> }], '/projects/p1', testUser(['projects.read', 'projects.write', 'projects.all']));

    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByText('Tor Tekniker')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Tor Tekniker from the team' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url === '/api/v1/projects/p1/members/u3' && init?.method === 'DELETE')).toBe(true));

    const add = screen.getByRole('button', { name: 'Add to team' });
    expect(add).toBeDisabled();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'Ola');
    await user.click(await screen.findByRole('option', { name: /Ola Olsen/ }));
    await user.click(add);
    await waitFor(() => {
      const post = fetch.mock.calls.find(([url, init]) => url === '/api/v1/projects/p1/members' && init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ userId: 'u4' });
    });
  });

  it('shows the team read-only to a technician, who is told the list holds the projects they are on', async () => {
    stub();
    renderRoutes(
      [
        { path: '/projects/:id', element: <ProjectPage /> },
        { path: '/projects', element: <ProjectsPage /> },
      ],
      '/projects/p1',
      testUser(['projects.read']),
    );

    expect(await screen.findByText('Tor Tekniker')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /from the team/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to team' })).not.toBeInTheDocument();
  });

  it('tells a technician whose projects the list shows', async () => {
    stub();
    renderRoutes([{ path: '/projects', element: <ProjectsPage /> }], '/projects', testUser(['projects.read']));

    expect(await screen.findByText('The projects you are on: as manager, team member or task assignee.')).toBeInTheDocument();
  });
});
