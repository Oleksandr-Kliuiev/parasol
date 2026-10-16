import type { ReactNode } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalM,
    paddingBlock: tokens.spacingVerticalXXL,
    paddingInline: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
  },
});

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Text>{message}</Text>
      {action}
    </div>
  );
}
