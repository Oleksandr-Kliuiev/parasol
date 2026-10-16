import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles({
  root: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalM },
  count: { color: tokens.colorNeutralForeground3 },
});

interface ListFooterProps {
  /** Rows loaded so far. */
  shown: number;
  /** Every row the filter matches, from the newest answer; unknown for lists that do not count. */
  total?: number | null;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}

/**
 * The end of a paged list (DEV-12): how many rows are shown of how many the filter matches, and the button for the next page.
 * The total is that of the latest answer — records added or changed meanwhile show up on a reload, nothing is promised as a
 * frozen snapshot.
 */
export function ListFooter({ shown, total, hasMore, loading, onMore }: ListFooterProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  if (!hasMore && (total == null || shown === 0)) return null;
  return (
    <div className={styles.root}>
      {total != null && (
        <Text className={styles.count} aria-live="polite">
          {t('common.shownOf', { shown, total: Math.max(total, shown) })}
        </Text>
      )}
      {hasMore && (
        <Button onClick={onMore} disabled={loading}>
          {t('common.loadMore')}
        </Button>
      )}
    </div>
  );
}
