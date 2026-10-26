import type { ConnectionJob, ConnectionStatusView } from '../features/integrations/connectionStatusContract';

const job = (name: string, lastSucceededAt: string | null, overrides: Partial<ConnectionJob> = {}): ConnectionJob => ({
  job: name, freshness: lastSucceededAt ? 'Fresh' : 'Never', lastSucceededAt, ageMinutes: lastSucceededAt ? 10 : null, thresholdMinutes: 60,
  lastRunAt: lastSucceededAt, lastRunStatus: lastSucceededAt ? 'Succeeded' : null, lastFailedAt: null, ...overrides,
});

/** Atera and Brønnøysund read on time, Atera's webhook heard, PowerOffice switched off and the worker beating: the green picture. */
export function connectionStatus(): ConnectionStatusView {
  return {
    status: 'Ready', checkedAt: '2026-10-16T10:00:00Z',
    integrations: [
      { system: 'atera', enabled: true, writeEnabled: false, state: { paused: false, failedOutbound: 0, jobs: [
        job('atera-alerts', '2026-10-16T09:50:00Z'), job('atera-tickets', '2026-10-16T09:55:00Z', { ageMinutes: 5, thresholdMinutes: 15 }),
      ] }, webhook: {
        enabled: true, lastReceivedAt: '2026-10-16T09:56:00Z', lastEventType: 'ticket', received: 12, lastRefusedAt: null, lastRefusal: null,
        lastEarlyReadAt: '2026-10-16T09:56:10Z',
      } },
      { system: 'poweroffice', enabled: false, writeEnabled: false, state: { paused: false, failedOutbound: 0, jobs: [
        job('poweroffice-customers', null, { freshness: 'Disabled' }),
      ] }, webhook: null },
      { system: 'brreg', enabled: true, writeEnabled: null, state: { paused: false, failedOutbound: 0, jobs: [
        job('brreg-registry-check', '2026-10-16T02:00:00Z', { ageMinutes: 480, thresholdMinutes: 1440 }),
      ] }, webhook: null },
    ],
    worker: { staleAfterSeconds: 180, components: [
      { component: 'outbox', state: 'Current', beatAt: '2026-10-16T09:59:40Z', ageSeconds: 20 },
      { component: 'jobs', state: 'Current', beatAt: '2026-10-16T09:59:20Z', ageSeconds: 40 },
      { component: 'actions', state: 'Current', beatAt: '2026-10-16T09:59:50Z', ageSeconds: 10 },
      { component: 'early-reads', state: 'Current', beatAt: '2026-10-16T09:59:55Z', ageSeconds: 5 },
    ] },
    gaps: [],
  };
}

/** The same installation with a gap of every kind. */
export function connectionGaps(): ConnectionStatusView {
  const view = connectionStatus();
  const atera = view.integrations[0]!.state!;
  atera.failedOutbound = 2;
  atera.jobs[0] = { ...atera.jobs[0]!, lastFailedAt: '2026-10-16T09:58:00Z', lastRunAt: '2026-10-16T09:57:00Z', lastRunStatus: 'Failed' };
  atera.jobs[1] = { ...atera.jobs[1]!, freshness: 'Stale', lastSucceededAt: '2026-10-16T08:00:00Z', ageMinutes: 120 };
  atera.jobs.push(job('atera-customers', null));
  view.integrations[2]!.state!.paused = true;
  view.integrations[2]!.state!.jobs[0]!.freshness = 'Paused';
  view.worker!.components[1] = { component: 'jobs', state: 'Late', beatAt: '2026-10-16T09:45:00Z', ageSeconds: 900 };
  return {
    ...view, status: 'Gaps',
    gaps: [
      { kind: 'Failed', system: 'atera', job: 'atera-alerts', component: null, count: null },
      { kind: 'Stale', system: 'atera', job: 'atera-tickets', component: null, count: null },
      { kind: 'Never', system: 'atera', job: 'atera-customers', component: null, count: null },
      { kind: 'OutboundFailed', system: 'atera', job: null, component: null, count: 2 },
      { kind: 'Paused', system: 'brreg', job: null, component: null, count: null },
      { kind: 'WorkerLate', system: null, job: null, component: 'jobs', count: null },
    ],
  };
}
