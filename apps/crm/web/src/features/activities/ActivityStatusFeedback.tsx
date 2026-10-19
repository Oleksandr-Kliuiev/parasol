import { MessageBar, MessageBarBody } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { activityUrl } from './activityNavigation';
import type { Activity } from './types';

export function ActivityStatusFeedback({ activity }: { activity: Activity }) {
  const { t } = useTranslation();
  return <MessageBar intent="warning" role="alert"><MessageBarBody>
    {t('activities.statusConflict')}{' '}
    <AppLink to={activityUrl(activity.organizationId, activity.id)}>{t('activities.reviewCurrent')}</AppLink>
  </MessageBarBody></MessageBar>;
}
