import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes } from '../../test/renderWithProviders';
import { atlasQueue } from '../../test/atlasQueue';
import { ObservationQueueInfo } from './ObservationQueueInfo';

describe('compact observation read information', () => {
  it('keeps read times and incomplete-source warnings visible while detailed counts stay available', async () => {
    renderRoutes([page(<ObservationQueueInfo queue={atlasQueue().queue!} />)], '/');
    expect(screen.getByText('Matches across pages: 27')).toBeVisible();
    expect(screen.getByText(/^Queue read at /)).toBeVisible();
    expect(screen.getByText(/^View assembled at /)).not.toBeVisible();
    expect(screen.getByText(/Sources to review: 2/)).toBeVisible();
    const note = screen.getByText(/Counts reflect this page request/);
    expect(note).not.toBeVisible();
    await userEvent.click(screen.getByText('Data details'));
    expect(note).toBeVisible();
    expect(screen.getByText(/^View assembled at /)).toBeVisible();
    expect(screen.getByText('Outdated snapshot')).toBeVisible();
    expect(screen.getByText('No snapshot')).toBeVisible();
  });

  it('requires review for errors, synthetic records, truncated results and missing freshness fields', async () => {
    const queue = atlasQueue().queue!; const base = queue.resources[0]!;
    queue.resources = [
      { ...base, status: 'ERROR', returnedItems: null },
      { ...base, status: 'FIXTURE', returnedItems: 0 },
      { ...base, status: 'OK', returnedItems: 25, truncated: true },
      { ...base, status: 'OK', returnedItems: 0, truncated: false, asOf: null },
      { ...base, status: 'OK', returnedItems: 0, truncated: false, lastSuccessAt: null },
    ];
    renderRoutes([page(<ObservationQueueInfo queue={queue} />)], '/');
    expect(screen.getByText(/Sources to review: 5/)).toBeVisible();
    await userEvent.click(screen.getByText('Data details'));
    expect(screen.getAllByText('Snapshot or last-success time is unavailable.')).toHaveLength(2);
    for (const reason of screen.getAllByText('Snapshot or last-success time is unavailable.')) expect(reason).toBeVisible();
  });

  it('does not label an empty source set as healthy or current', () => {
    const queue = atlasQueue().queue!; queue.resources = [];
    renderRoutes([page(<ObservationQueueInfo queue={queue} />)], '/');
    expect(screen.getByRole('status')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('No source snapshots are available.');
    expect(screen.queryByText(/Sources to review: 0/)).not.toBeInTheDocument();
  });

  it('retains access to complete source evidence without claiming device health', async () => {
    const queue = atlasQueue().queue!;
    queue.resources = queue.resources.slice(0, 1).map(r => ({ ...r, status: 'OK', truncated: false }));
    renderRoutes([page(<ObservationQueueInfo queue={queue} />)], '/');
    expect(screen.queryByText(/Sources to review:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Data details'));
    expect(screen.getByText('Current snapshot')).toBeVisible();
    expect(screen.getByText(/Counts cover records stored in Atlas/)).toBeVisible();
  });
});
