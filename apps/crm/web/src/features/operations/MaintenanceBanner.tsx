import { makeStyles } from '@fluentui/react-components';
import { WrenchScrewdriver20Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { cardSurface, h } from '../../app/hearth';
import { formatDateTime } from '../../shared/utils/format';
import { IconChip } from '../admin/IconChip';
import { usePublicMaintenance } from './api';

const useStyles = makeStyles({
  // A quiet attention row above the page: a saffron chip, the title and why changes are refused.
  banner: {
    ...cardSurface,
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    marginBottom: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '16px',
    borderLeft: `4px solid ${h.saffron}`,
    minWidth: 0,
  },
  text: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere', paddingTop: '1px' },
  title: { fontWeight: 600, fontSize: '14px', lineHeight: '20px' },
  body: { color: h.text, fontSize: '13px', lineHeight: '18px' },
});

/** On every page while the CRM is read-only (DEV-13): reading works, and the person knows why a change is refused. */
export function MaintenanceBanner() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { data } = usePublicMaintenance();
  if (data?.mode !== 'ReadOnly') return null;

  return (
    <div className={styles.banner} role="status">
      <IconChip icon={<WrenchScrewdriver20Regular />} tone="saffron" small />
      <div className={styles.text}>
        <span className={styles.title}>{t('maintenance.banner.title')}</span>
        <span className={styles.body}>
          {data.since ? t('maintenance.banner.bodySince', { since: formatDateTime(data.since) }) : t('maintenance.banner.body')}
        </span>
        {data.reason && <span className={styles.body}>{t('maintenance.banner.reason', { reason: data.reason })}</span>}
      </div>
    </div>
  );
}
