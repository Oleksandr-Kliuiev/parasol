import type { ReactElement, ReactNode } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  // The attention row of the visual system (see ObservationContext): icon, bold title, muted meta, then state and action.
  root: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: '12px',
    rowGap: '8px',
    minWidth: 0,
    '@media (max-width: 560px)': { gridTemplateColumns: '32px minmax(0, 1fr)' },
  },
  icon: { display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '10px', backgroundColor: h.well, color: h.muted },
  body: { display: 'grid', gap: '2px', minWidth: 0 },
  title: { fontWeight: 600, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere' },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: '2px',
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
    // Facts side by side with a gap, no separators: a wrapped line never starts with a dot.
    columnGap: '14px',
  },
  aside: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '8px',
    '@media (max-width: 560px)': { gridColumn: '2', alignItems: 'flex-start' },
  },
  state: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '6px 8px',
    '@media (max-width: 560px)': { justifyContent: 'flex-start' } },
});

/** One technical record as an attention row. Its aside is short (one action), so it stays beside the text down to phone width. */
export function TechnicalItem({ icon, title, meta, state, action }: {
  icon: ReactElement; title: ReactNode; meta?: ReactNode[]; state?: ReactNode; action?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-technical-item="">
      <span className={styles.icon} aria-hidden>{icon}</span>
      <div className={styles.body}>
        <span className={styles.title}>{title}</span>
        {meta && meta.length > 0 && <div className={styles.meta}>{meta}</div>}
      </div>
      <div className={styles.aside}>
        {state && <div className={styles.state}>{state}</div>}
        {action}
      </div>
    </div>
  );
}
