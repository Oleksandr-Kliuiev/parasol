import { Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import type { Subscription } from './types';

const useStyles = makeStyles({ readAt: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' } });

/**
 * When the subscriptions on screen were last read from Partner Center (the newest reading among them): licence counts and
 * renewal dates are a mirror, so the list says how old the mirror is. Nothing is said for an empty list.
 */
export function LicenceReadAt({ rows }: { rows: readonly Subscription[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const newest = rows.reduce<string | null>((latest, row) => (latest === null || row.syncedAt > latest ? row.syncedAt : latest), null);
  if (newest === null) return null;
  return (
    <Text className={styles.readAt}>
      {t('licenses.readFrom')} <time dateTime={newest} title={formatDateTime(newest)}>{formatRelative(newest)}</time>
    </Text>
  );
}
