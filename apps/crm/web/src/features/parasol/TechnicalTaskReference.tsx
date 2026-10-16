import { Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { formatDateTime } from '../../shared/utils/format';
import type { TechnicalTaskRef } from './observationTaskContract';

export function TechnicalTaskReference({ task, onNavigate }: { task: TechnicalTaskRef; onNavigate?: () => void }) {
  const { t } = useTranslation(); const canRead = useCan(Permissions.activitiesRead);
  return <>
    <Text block>{t(task.isAvailable ? 'parasolWork.existingKept' : 'parasolWork.taskUnavailable')}</Text>
    <Text block>{t('parasolWork.taskState', { state: t(`parasolWork.taskStatus.${task.status}`) })}</Text>
    {task.isAvailable && <>
      <Text block>{t(task.assigneeId ? 'parasolWork.assigned' : 'parasolWork.unassigned')}</Text>
      <Text block>{task.dueAt ? t('activities.dueAt', { at: formatDateTime(task.dueAt) }) : t('parasolWork.noDue')}</Text>
      {canRead && <AppLink to={`/organizations/${encodeURIComponent(task.organizationId)}?tab=activities`} onClick={onNavigate}>{t('parasolWork.openActivities')}</AppLink>}
    </>}
  </>;
}
