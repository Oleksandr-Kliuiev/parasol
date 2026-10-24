import { Badge, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '../../api/types';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { formatDateTime } from '../../shared/utils/format';
import { actorKind, useActorName } from './actor';
import { ActorMark } from './AuditActor';
import { ChangeList } from './ChangeList';
import { actionColor, recordLink } from './entries';
import { useAuditLabels } from './labels';

const useStyles = makeStyles({
  // The phone layout of the audit log: one card per entry instead of a table five columns wide.
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' },
  card: {
    display: 'grid',
    gap: '10px',
    minWidth: 0,
    paddingTop: '12px',
    paddingBottom: '14px',
    paddingLeft: '14px',
    paddingRight: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '16px',
    boxShadow: tokens.shadow4,
  },
  head: { display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', columnGap: '10px', alignItems: 'center' },
  who: { display: 'grid', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere' },
  quiet: { color: h.muted },
  meta: { color: h.muted, fontSize: '12px', lineHeight: '16px', fontVariantNumeric: 'tabular-nums' },
  // The line breaks between its parts, never inside one ("Sign-in session · Users and sign-in · 20/10/2026, 16:01").
  segment: { whiteSpace: 'nowrap' },
  record: { fontWeight: tokens.fontWeightSemibold, color: h.text },
  changes: { paddingTop: '10px', borderTop: `1px solid ${h.line}` },
  erased: { color: h.muted, fontSize: '13px' },
});

export function AuditEntryCards({ entries }: { entries: AuditEntry[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const labels = useAuditLabels();
  const actorName = useActorName();
  return (
    <ol className={mergeClasses(styles.list, 'h-stagger')} aria-label={t('audit.title')}>
      {entries.map((entry) => {
        const link = recordLink(entry);
        const type = labels.entityType(entry.entityType);
        const hasChanges = !!entry.changes && typeof entry.changes === 'object' && Object.keys(entry.changes).length > 0;
        return (
          <li key={entry.id} className={styles.card}>
            <div className={styles.head}>
              <ActorMark entry={entry} />
              <span className={styles.who}>
                <span className={mergeClasses(styles.name, actorKind(entry) !== 'person' && styles.quiet)}>{actorName(entry)}</span>
                <span className={styles.meta}>
                  <span className={mergeClasses(styles.segment, styles.record)}>
                    {link && entry.action !== 'Delete' && !entry.erased ? <AppLink to={link}>{type}</AppLink> : type}
                  </span>
                  {' · '}
                  <span className={styles.segment}>{labels.module(entry.module)}</span>
                  {' · '}
                  <span className={styles.segment}>{formatDateTime(entry.at)}</span>
                </span>
              </span>
              <Badge appearance="tint" color={actionColor(entry.action)}>{labels.action(entry.action)}</Badge>
            </div>
            {entry.erased ? (
              <span className={mergeClasses(styles.changes, styles.erased)}>{t('history.erased')}</span>
            ) : (
              hasChanges && (
                <div className={styles.changes}>
                  <ChangeList changes={entry.changes} entityType={entry.entityType} />
                </div>
              )
            )}
          </li>
        );
      })}
    </ol>
  );
}
