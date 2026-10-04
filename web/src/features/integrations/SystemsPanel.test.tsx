import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@fluentui/react-components';
import type { ConnectionTestStatus, IntegrationStatus } from '../../api/types';
import { TOASTER_ID } from '../../app/toaster';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { SystemsPanel } from './SystemsPanels';

const status: IntegrationStatus[] = [
  {
    system: 'poweroffice', enabled: true, recordTypes: ['Customer'], records: 3, unlinked: 1,
    pendingOutbound: 0, failedOutbound: 0, paused: false, pauseReason: null, pausedAt: null, pausedBy: null,
  },
];

const queued: ConnectionTestStatus = {
  id: 't1', system: 'poweroffice', status: 'Running', success: null, message: null, requestedAt: '2026-10-04T08:00:00Z', finishedAt: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('SystemsPanel', () => {
  it('queues the connection test for the worker and shows its answer when it comes', async () => {
    let answered = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(queued), { status: 202 });
      if (url === '/api/v1/integrations/poweroffice/test/t1') {
        // The worker answers on the second question.
        const answer = answered
          ? { ...queued, status: 'Succeeded', success: true, message: 'Connected to PowerOffice Go (Demo).', finishedAt: '2026-10-04T08:00:03Z' }
          : queued;
        answered = true;
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      return new Response(JSON.stringify(status), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes(
      [{ path: '/admin', element: <><Toaster toasterId={TOASTER_ID} /><SystemsPanel /></> }],
      '/admin',
      testUser(['integrations.manage']),
    );

    await user.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByRole('button', { name: 'Testing…' })).toBeDisabled();
    expect(await screen.findByText('Connected to PowerOffice Go (Demo).', undefined, { timeout: 5_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/integrations/poweroffice/test/t1').length).toBeGreaterThanOrEqual(2);
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe('/api/v1/integrations/poweroffice/test');
  });
});
