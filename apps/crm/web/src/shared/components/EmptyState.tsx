import type { ReactElement, ReactNode } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { Search24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  // The empty state of the reference: a quiet icon, the sentence, the next step under it; centred in its card.
  root: {
    display: 'grid',
    justifyItems: 'center',
    gap: '6px',
    paddingTop: '32px',
    paddingBottom: '32px',
    paddingLeft: '16px',
    paddingRight: '16px',
    textAlign: 'center',
    color: h.muted,
  },
  icon: { display: 'grid', placeItems: 'center', color: h.faint, opacity: 0.8, marginBottom: '2px', '& svg': { width: '28px', height: '28px' } },
  title: { margin: 0, color: h.text, fontSize: '14px', fontWeight: 700 },
  text: { margin: 0, maxWidth: '46ch', fontSize: '13px', lineHeight: '19px' },
  action: { marginTop: '8px' },
  // A side card with nothing to say is one quiet line, so an all-clear never takes the room of work (My day).
  compact: {
    display: 'flex',
    alignItems: 'center',
    justifyItems: 'start',
    gap: '8px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: 0,
    paddingRight: 0,
    textAlign: 'start',
  },
  compactIcon: { marginBottom: 0, flexShrink: 0, '& svg': { width: '18px', height: '18px' } },
});

interface EmptyStateProps {
  message: string;
  title?: string;
  icon?: ReactElement;
  action?: ReactNode;
  /** One line at the start of the card instead of the centred block. */
  compact?: boolean;
}

export function EmptyState({ message, title, icon, action, compact = false }: EmptyStateProps) {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.root, compact && styles.compact)}>
      <span className={mergeClasses(styles.icon, compact && styles.compactIcon)} aria-hidden>
        {icon ?? <Search24Regular />}
      </span>
      {title && <p className={styles.title}>{title}</p>}
      <p className={styles.text}>{message}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
