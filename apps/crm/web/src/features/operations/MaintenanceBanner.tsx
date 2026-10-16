import { MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import { usePublicMaintenance } from './api';

const useStyles = makeStyles({
  banner: { marginBottom: tokens.spacingVerticalL },
});

/** On every page while the CRM is read-only (DEV-13): reading works, and the person knows why a change is refused. */
export function MaintenanceBanner() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { data } = usePublicMaintenance();
  if (data?.mode !== 'ReadOnly') return null;

  return (
    <MessageBar intent="warning" layout="multiline" className={styles.banner}>
      <MessageBarBody>
        <MessageBarTitle>{t('maintenance.banner.title')}</MessageBarTitle>
        {data.since ? t('maintenance.banner.bodySince', { since: formatDateTime(data.since) }) : t('maintenance.banner.body')}
        {data.reason && <div>{t('maintenance.banner.reason', { reason: data.reason })}</div>}
      </MessageBarBody>
    </MessageBar>
  );
}
