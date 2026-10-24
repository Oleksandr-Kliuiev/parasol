import type { ReactElement, ReactNode } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { h, tone as tones, type Tone } from '../../app/hearth';

/** The record row of the visual system: flag, bold title, muted meta line, status or action on the right. */
// A flex row rather than a grid: in a narrow panel the status and amount wrap under the title instead of squeezing it.
const useRowStyles = makeStyles({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '8px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '20px',
    paddingRight: '20px',
    borderTop: `1px solid ${h.line}`,
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' },
  },
  flag: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    borderRadius: '10px',
    '& svg': { width: '16px', height: '16px' },
  },
  main: { display: 'grid', gap: '2px', flexGrow: 1, flexShrink: 1, flexBasis: '200px', minWidth: 0 },
  title: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '8px', rowGap: '4px', fontSize: '14px', lineHeight: '20px', fontWeight: 600, overflowWrap: 'anywhere' },
  meta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere' },
  end: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    marginLeft: 'auto',
    fontVariantNumeric: 'tabular-nums',
  },
});

interface RecordRowProps {
  /** A 16 px icon, shown in a tinted 32 px square. */
  icon?: ReactElement;
  /** A 32 px Avatar in place of the icon square. */
  avatar?: ReactElement;
  /** Tints the icon square. */
  tone?: Tone;
  title: ReactNode;
  meta?: ReactNode;
  /** Status pill, amount or action, aligned right. */
  end?: ReactNode;
  className?: string;
}

/** One record of a list inside a panel, rendered as a list item. */
export function RecordRow({ icon, avatar, tone = 'neutral', title, meta, end, className }: RecordRowProps) {
  const styles = useRowStyles();
  return (
    <li className={mergeClasses(styles.row, className)}>
      {avatar}
      {icon && !avatar && (
        <span className={styles.flag} style={{ color: tones[tone].text, backgroundColor: tones[tone].soft }} aria-hidden>
          {icon}
        </span>
      )}
      <div className={styles.main}>
        <div className={styles.title}>{title}</div>
        {meta}
      </div>
      {end && <div className={styles.end}>{end}</div>}
    </li>
  );
}

/** The muted line under a row title; several lines may follow each other. */
export function RowMeta({ children, className }: { children: ReactNode; className?: string }) {
  const styles = useRowStyles();
  return <div className={mergeClasses(styles.meta, className)}>{children}</div>;
}
