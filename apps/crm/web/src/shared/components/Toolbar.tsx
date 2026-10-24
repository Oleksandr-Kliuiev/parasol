import { useRef, type ReactElement, type ReactNode } from 'react';
import { Field, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { useReveal } from '../../app/motion';

const useStyles = makeStyles({
  // The filter row of the reference's lists: controls of one height on one line, wrapping on narrow screens; the search
  // grows, the rest keeps its size. No labels above the controls, so every control starts on the same line.
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '16px',
    minWidth: 0,
  },
  end: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' },
  search: { flex: '1 1 240px', maxWidth: '360px', minWidth: 'min(240px, 100%)' },
  filter: { flex: '0 1 auto', minWidth: 'min(170px, 100%)' },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
    padding: 0,
  },
  chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '32px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '999px',
    border: `1px solid ${h.line}`,
    backgroundColor: h.surface,
    color: h.muted,
    fontFamily: 'inherit',
    fontSize: '12.5px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color, transform',
    transitionDuration: '0.15s',
    ':hover': { borderTopColor: h.line2, borderRightColor: h.line2, borderBottomColor: h.line2, borderLeftColor: h.line2, color: h.text },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    '@media (hover: none)': { height: '40px', ':active': { transform: 'scale(0.97)' } },
    '& b': { color: h.text, fontVariantNumeric: 'tabular-nums' },
  },
  chipOn: {
    backgroundColor: h.ink,
    color: h.onInk,
    borderTopColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
    ':hover': { color: h.onInk, borderTopColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: 'transparent' },
    '& b': { color: 'inherit' },
  },
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  // A count of an earlier filter keeps its place while the new one is read, unseen, so the chips do not change size.
  pending: { visibility: 'hidden' },
});

/** A row of filters above a list: search first, then filters, `end` for actions that belong to the list. */
export function Toolbar({ children, end, label, className }: { children: ReactNode; end?: ReactNode; label?: string; className?: string }) {
  const styles = useStyles();
  const ref = useRef<HTMLDivElement>(null);
  // The filters rise with the page, between its header and the list.
  useReveal(ref, 'item');
  return (
    <div ref={ref} className={mergeClasses(styles.toolbar, className)} role={label ? 'group' : undefined} aria-label={label}>
      {children}
      {end && <div className={styles.end}>{end}</div>}
    </div>
  );
}

/**
 * A filter control whose label is read by assistive technology but not shown: in a filter row the control itself says
 * what it filters ("All statuses", the search placeholder). Use it for selects, searches and pickers in a Toolbar.
 */
export function FilterField({ label, children, kind = 'filter' }: { label: string; children: ReactElement; kind?: 'search' | 'filter' }) {
  const styles = useStyles();
  return (
    <Field className={kind === 'search' ? styles.search : styles.filter} label={{ children: label, className: styles.hidden }}>
      {children}
    </Field>
  );
}

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  /** A coloured dot before the label (a status colour). */
  dot?: string;
}

/**
 * Status filters as chips with their counts (the reference's list filters); the pressed chip is the active filter.
 * `countsPending`: the counts are those of an earlier search while the new ones are read; they are not shown, but keep their room.
 */
export function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
  countsPending = false,
}: {
  label: string;
  value: T;
  options: Array<FilterChipOption<T>>;
  onChange: (value: T) => void;
  countsPending?: boolean;
}) {
  const styles = useStyles();
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={mergeClasses(styles.chip, option.value === value && styles.chipOn)}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.dot && <span className={styles.dot} style={{ backgroundColor: option.dot }} aria-hidden />}
          {option.label}
          {/* A hidden comma keeps the label and its count apart for screen readers ("Not linked, 17"). A pending count keeps all of its
              parts, unseen and unread: without one of them the chip is narrower and the row of filters can wrap anew. */}
          {option.count !== undefined && <>
            <span className={styles.hidden} aria-hidden={countsPending || undefined}>,</span>{' '}
            <b className={countsPending ? styles.pending : undefined} aria-hidden={countsPending || undefined}>{option.count}</b>
          </>}
        </button>
      ))}
    </div>
  );
}
