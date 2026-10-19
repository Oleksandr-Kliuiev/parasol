import type { LocalReadinessView, ReadinessAuthority } from '../features/parasol/localReadinessContract';

export const readinessAdminAuthority: ReadinessAuthority = { atlasRead: true, integrationsManage: true, customersRead: true };
export function localReadiness(authority = readinessAdminAuthority): LocalReadinessView {
  const stored = { paused: false, lastSucceededAt: '2026-10-15T10:00:00Z', records: 4, unlinkedRecords: 1, pendingOutbound: 2, failedOutbound: 1 };
  return {
    status: 'LOCAL_SNAPSHOT', checkedAt: '2026-10-16T10:00:00Z', scope: 'LOCAL_ONLY', connectivity: 'NOT_CHECKED',
    personalAtlas: authority.atlasRead ? { status: 'PERSONAL_ENTRY_PRESENT' } : null,
    admin: authority.integrationsManage ? {
      authMode: 'ENTRA', atera: { enabled: false, writeEnabled: false, stored: { ...stored } },
      powerOffice: { enabled: true, writeEnabled: false, stored: { ...stored, paused: true } },
      microsoftGraph: { enabled: false, calendarEnabled: false, mailEnabled: false, sharePointEnabled: false, teamsEnabled: false,
        stored: { directoryLastSucceededAt: '2020-01-01T10:00:00Z', roleLastSucceededAt: null } },
      huntress: { managedBy: 'ATLAS', configuration: 'UNKNOWN', connectivity: 'NOT_CHECKED' },
      atlasMappings: authority.customersRead ? { status: 'CHECKED', reviewStatus: 'NO_LOCAL_ISSUES_FOUND', scope: 'STORED_LOCAL_REGISTRY', limit: 500,
        coverage: { storedLinks: 2, examinedLinks: 2, omittedLinks: 0, unlinkedStoredReferences: 0 },
        counts: { validLinks: 2, invalidIdentities: 0, missingReferences: 0, goneReferences: 0, invalidReferences: 0, unavailableCustomers: 0 } } : null,
    } : null,
  };
}
