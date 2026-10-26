import type { TFunction } from 'i18next';
import type { BackupEntity, BackupService, BackupServiceCounts, BackupState } from './types';

/** A service as people say it ("E-post", "OneDrive"); one CloudAlly does not name in Parasoll's words keeps its code. */
export const serviceName = (t: TFunction, service: string) => t(`backup.services.${service}`, { defaultValue: service });

/** A state as people say it ("Feilet", "Ikke i kopi"). */
export const stateName = (t: TFunction, state: BackupState) => t(`backup.states.${state}`);

/** The tint of a state's badge: a failure in red, what waits for someone in amber, the rest quiet. */
export function stateColor(state: BackupState): 'danger' | 'warning' | 'success' | 'informative' | 'subtle' {
  switch (state) {
    case 'Failed': return 'danger';
    case 'Late': case 'Paused': case 'NotInBackup': return 'warning';
    case 'Ok': return 'success';
    case 'Waiting': return 'informative';
    default: return 'subtle';
  }
}

/** The person's or site's name with the address, or the address alone. */
export const entityName = (entity: Pick<BackupEntity, 'name' | 'fullName'>) =>
  entity.fullName && entity.fullName !== entity.name ? `${entity.fullName} (${entity.name})` : entity.name;

/** The problems of one service, most serious first, as one short line; null when there are none. */
export function serviceProblems(t: TFunction, counts: BackupServiceCounts): string | null {
  const parts = ([['failed', counts.failed], ['late', counts.late], ['paused', counts.paused], ['notInBackup', counts.notInBackup]] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(`backup.problems.${key}`, { count }));
  return parts.length ? parts.join(' · ') : null;
}

/** The services in their own order, so the tiles stand where people expect them whatever CloudAlly lists first. */
export const serviceOrder: Record<BackupService, number> = { Mail: 0, OneDrive: 1, SharePoint: 2, Teams: 3, Other: 4 };
