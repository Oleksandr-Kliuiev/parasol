import { Button, Skeleton, SkeletonItem, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { History16Regular, History24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime } from '../../shared/utils/format';
import { actorKind, useActorName } from './actor';
import { useEntityHistory } from './api';
import { ActorMark } from './AuditActor';
import { ChangeList } from './ChangeList';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  // A timeline: who made the change marks the step, a hairline joins the steps.
  item: {
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr)',
    columnGap: '12px',
    paddingBottom: '16px',
    position: 'relative',
  },
  marker: { display: 'grid', placeItems: 'center', width: '28px', height: '28px' },
  line: { position: 'absolute', left: '13px', top: '34px', bottom: '4px', width: '2px', borderRadius: '1px', backgroundColor: h.line },
  body: { minWidth: 0, paddingTop: '4px', overflowWrap: 'anywhere' },
  heading: { display: 'flex', flexWrap: 'wrap', columnGap: '8px', rowGap: '2px', alignItems: 'baseline', marginBottom: '8px' },
  name: { fontWeight: tokens.fontWeightSemibold },
  quiet: { color: h.muted },
  action: { color: h.muted },
  time: { color: h.muted, fontSize: '12.5px', fontVariantNumeric: 'tabular-nums' },
  erased: { color: h.muted, fontSize: '13px' },
  more: { justifySelf: 'start' },
  footer: { display: 'grid', paddingLeft: '40px' },
});

interface HistoryListProps {
  module: string;
  entityType: string;
  entityId: string;
  compact?: boolean;
}

export function HistoryList({ module, entityType, entityId, compact = false }: HistoryListProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const actorName = useActorName();
  const { data, error, isPending, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useEntityHistory(module, entityType, entityId);
  const entries = data?.pages.flatMap((p) => p.items) ?? [];

  const body = (() => {
    if (isPending)
      return (
        <Skeleton aria-label={t('common.loading')}>
          <SkeletonItem />
          <SkeletonItem />
        </Skeleton>
      );
    if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
    if (entries.length === 0) return <EmptyState message={t('history.empty')} icon={<History24Regular />} />;
    return (
      <>
        <ol className={mergeClasses(styles.list, 'h-stagger')}>
          {entries.map((entry, index) => (
            <li key={entry.id} className={styles.item}>
              <span className={styles.marker} aria-hidden>
                <ActorMark entry={entry} />
              </span>
              {index < entries.length - 1 && <span className={styles.line} aria-hidden />}
              <div className={styles.body}>
                <div className={styles.heading}>
                  <Text className={mergeClasses(styles.name, actorKind(entry) !== 'person' && styles.quiet)}>{actorName(entry)}</Text>
                  <Text className={styles.action}>{t(`history.actions.${entry.action}`, { defaultValue: entry.action })}</Text>
                  <Text className={styles.time}>{formatDateTime(entry.at)}</Text>
                </div>
                {entry.erased ? (
                  <Text className={styles.erased}>{t('history.erased')}</Text>
                ) : entry.action !== 'Create' || !compact ? (
                  <ChangeList changes={entry.changes} entityType={entityType} />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {hasNextPage && (
          <div className={styles.footer}>
            <Button className={styles.more} onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </>
    );
  })();

  return compact ? (
    body
  ) : (
    <Panel title={t('history.title')} icon={<History16Regular />}>
      {body}
    </Panel>
  );
}
