import { useId, type ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingInline: tokens.spacingHorizontalXL,
    paddingBlock: tokens.spacingVerticalXL,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    '@media (max-width: 600px)': { paddingInline: tokens.spacingHorizontalL, paddingBlock: tokens.spacingVerticalL },
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalS,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    maxWidth: '100%',
    minWidth: 0,
  },
  heading: {
    margin: `0 0 ${tokens.spacingVerticalM}`,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    flexShrink: 0,
    maxWidth: '100%',
    overflowWrap: 'anywhere',
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, max-content) 1fr',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    margin: 0,
  },
  term: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase300 },
  value: { margin: 0, overflowWrap: 'anywhere', fontSize: tokens.fontSizeBase300 },
});

/** A titled section; the title names the region, so screen reader users can jump between panels. */
export function Panel({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <section className={styles.panel} aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className={styles.header}>
          {title && (
            <h2 id={headingId} className={styles.heading}>
              {title}
            </h2>
          )}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  const styles = useStyles();
  return (
    <dl className={styles.list}>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt className={styles.term}>{item.label}</dt>
          <dd className={styles.value}>{item.value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
