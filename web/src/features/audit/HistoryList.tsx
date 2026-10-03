import { Button, Skeleton, SkeletonItem, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime } from '../../shared/utils/format';
import { useEntityHistory } from './api';
import { ChangeList } from './ChangeList';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  item: {
    display: 'grid',
    gridTemplateColumns: '12px 1fr',
    columnGap: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalL,
    position: 'relative',
  },
  dot: {
    width: '10px',
    height: '10px',
    marginTop: '5px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
  },
  line: { position: 'absolute', left: '4px', top: '18px', bottom: 0, width: '2px', backgroundColor: tokens.colorNeutralStroke2 },
  heading: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'baseline', marginBottom: tokens.spacingVerticalXS },
  time: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingHorizontalL,
  },
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
    if (entries.length === 0) return <EmptyState message={t('history.empty')} />;
    return (
      <>
        <ol className={styles.list}>
          {entries.map((entry, index) => (
            <li key={entry.id} className={styles.item}>
              <span className={styles.dot} aria-hidden />
              {index < entries.length - 1 && <span className={styles.line} aria-hidden />}
              <div>
                <div className={styles.heading}>
                  <Text weight="semibold">{entry.userName ?? t('history.system')}</Text>
                  <Text>{t(`history.actions.${entry.action}`, { defaultValue: entry.action })}</Text>
                  <Text size={200} className={styles.time}>
                    {formatDateTime(entry.at)}
                  </Text>
                </div>
                {entry.action !== 'Create' || !compact ? <ChangeList changes={entry.changes} /> : null}
              </div>
            </li>
          ))}
        </ol>
        {hasNextPage && (
          <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        )}
      </>
    );
  })();

  return compact ? body : <div className={styles.panel}>{body}</div>;
}
