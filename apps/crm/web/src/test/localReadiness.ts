import type { LocalReadinessView } from '../features/integrations/localReadinessContract';

export function localReadiness(): LocalReadinessView {
  const stored = { paused: false, lastSucceededAt: '2026-10-15T10:00:00Z', records: 4, unlinkedRecords: 1, pendingOutbound: 2, failedOutbound: 1 };
  return {
    status: 'LOCAL_SNAPSHOT', checkedAt: '2026-10-16T10:00:00Z', scope: 'LOCAL_ONLY', connectivity: 'NOT_CHECKED',
    admin: {
      authMode: 'ENTRA', atera: { enabled: false, writeEnabled: false, stored: { ...stored } },
      powerOffice: { enabled: true, writeEnabled: false, stored: { ...stored, paused: true } },
      microsoftGraph: { enabled: false, calendarEnabled: false, mailEnabled: false, sharePointEnabled: false, teamsEnabled: false,
        stored: { directoryLastSucceededAt: '2020-01-01T10:00:00Z', roleLastSucceededAt: null } },
    },
  };
}
