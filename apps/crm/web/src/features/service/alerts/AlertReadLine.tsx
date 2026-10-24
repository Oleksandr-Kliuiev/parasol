import { Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Warning16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { AppLink } from '../../../shared/components/AppLink';
import { formatReadAt } from '../../../shared/utils/format';
import type { AlertSourceRead } from '../types';
import { alertsFreshness } from './alertReads';
import { sourceName } from './alertText';

const useStyles = makeStyles({
  // The mark stays beside the first line of its words; the words and the link wrap as text inside the room left.
  line: {
    display: 'inline-flex', alignItems: 'flex-start', columnGap: '4px', minWidth: 0, maxWidth: '100%',
    color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums',
  },
  // A read that did not finish, or whose successor is overdue, is said in the warning tone with its mark.
  warning: { color: h.saffronT, '& svg': { flexShrink: 0, marginTop: '1px' } },
  words: { minWidth: 0 },
  // A link inside a line of small text keeps a 24 px hit box (WCAG 2.5.8) without making its line taller than the others.
  link: { display: 'inline-block', paddingTop: '3px', paddingBottom: '3px', marginTop: '-3px', marginBottom: '-3px' },
});

/**
 * How fresh the stored alerts are, said the same way wherever alerts are shown (M38): "Atera read at 15:05"; a read that did not
 * finish, or a next read that is overdue, in the warning tone with the way to the connections page for whoever may open it; "not
 * read yet" before the first read. Never more than the reads proved.
 */
export function AlertReadLine<T extends AlertSourceRead>({ reads, className, label, texts = 'alerts.reads' }: {
  reads: readonly T[]; className?: string;
  /** What each read is called; the source system's name by default ("Atera"), "Open tickets (Atera)" for the service reads (M39.2). */
  label?: (read: T) => string;
  /** Where the sentences live: the service reads name plural sources, which Nynorsk participles agree with ("lesne"). */
  texts?: 'alerts.reads' | 'service.readLine';
}) {
  const { t } = useTranslation(); const styles = useStyles();
  const canConnections = useCan(Permissions.integrationsManage);
  const freshness = alertsFreshness(reads);
  const warn = freshness === 'incomplete' || freshness === 'late';
  const said = (read: T) => {
    const source = label ? label(read) : sourceName(t, read.system);
    if (read.startedAt === null) return t(`${texts}.notRead`, { source });
    const key = !read.complete ? `${texts}.incomplete` : read.late ? `${texts}.late` : `${texts}.readAt`;
    return t(key, { source, time: formatReadAt(read.startedAt) });
  };
  const link = warn && canConnections;
  return <Text className={mergeClasses(styles.line, warn && styles.warning, className)}>
    {warn && <Warning16Regular aria-hidden />}
    {/* The dot is bound to the last word by a no-break space, so a line that wraps before the link never starts with it. */}
    <span className={styles.words}>
      {reads.map(said).join(' · ')}
      {link && <>{' · '}<AppLink className={styles.link} to="/connections">{t('alerts.reads.connections')}</AppLink></>}
    </span>
  </Text>;
}
