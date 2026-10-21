import type { ReactNode } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { countable } from '../../shared/components/countable';

const useStyles = makeStyles({
  // The fact tiles of a panel (FactGrid's look) with a third row for context: label, figure, note. The rows are shared by
  // the tiles of a line (subgrid), so a two-line label or a missing note never lifts one figure off the line of the others.
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(112px, 100%), 1fr))',
    gap: '10px',
    margin: 0,
    '@media (max-width: 560px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  fact: {
    display: 'grid',
    gridRow: 'span 3',
    gridTemplateRows: 'subgrid',
    rowGap: '4px',
    minWidth: 0,
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  term: { color: h.muted, fontSize: '12px', fontWeight: 600, lineHeight: '16px' },
  value: { margin: 0, alignSelf: 'end', fontFamily: h.display, fontSize: '18px', lineHeight: '24px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  note: { margin: 0, color: h.muted, fontSize: '12px', lineHeight: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
});

export interface Figure {
  label: string;
  value: ReactNode;
  /** A short context under the figure: the amount of the deals counted, how many devices are offline. */
  note?: ReactNode;
}

/** A handful of counts read at a glance, each with an optional line of context. */
export function FigureGrid({ items, className }: { items: Figure[]; className?: string }) {
  const styles = useStyles();
  return (
    <dl className={mergeClasses(styles.grid, className)}>
      {items.map((item) => (
        <div key={item.label} className={styles.fact}>
          <dt className={styles.term}>{item.label}</dt>
          <dd className={styles.value}>{countable(item.value ?? '—')}</dd>
          {item.note ? <dd className={styles.note}>{item.note}</dd> : <span aria-hidden />}
        </div>
      ))}
    </dl>
  );
}
