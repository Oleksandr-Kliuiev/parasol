import type { UrgentAlert, UrgentAlerts } from '../features/dashboard/urgentAlerts';
import { alertRead } from './alerts';

/** A synthetic open alert of the Service module's urgent list. */
export function urgentAlert(id: string, overrides: Partial<UrgentAlert> = {}): UrgentAlert {
  return {
    id, organizationId: `org-${id}`, organizationName: 'Fjordkraft Test AS', system: 'atera', kind: 'Monitoring', externalId: `ext-${id}`,
    severity: 'Critical', state: 'Open', title: 'Disk C: almost full', deviceName: 'SRV-01', deviceId: `dev-${id}`,
    createdAt: '2026-10-20T06:00:00Z', lastSeenAt: '2026-10-21T06:25:00Z', resolvedAt: null, url: null, ...overrides,
  };
}

/** Two open alerts of seven, Atera read completely at 08:30 Oslo time on 21 October. */
export function urgentAlerts(overrides: Partial<UrgentAlerts> = {}): UrgentAlerts {
  return {
    items: [
      urgentAlert('a1'),
      urgentAlert('a2', { severity: 'Warning', title: 'Backup agent offline', organizationName: 'Havbris Test AS', deviceName: 'PC-17', createdAt: '2026-10-21T05:00:00Z' }),
    ],
    totalCount: 7, critical: 1, warning: 6,
    reads: [alertRead()],
    ...overrides,
  };
}
