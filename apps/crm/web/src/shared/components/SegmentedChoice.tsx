import { useId } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  // The segmented control of the visual system (hearthSurfaces' tab list) over native radio buttons: one tab stop, arrow keys
  // move the choice, and a screen reader hears a group of options with the one chosen.
  group: {
    display: 'inline-flex', gap: '2px', padding: '3px', borderRadius: '12px', backgroundColor: h.well, maxWidth: '100%', boxSizing: 'border-box',
    // On a phone the choices share the width and a long label takes two lines instead of pushing the page sideways.
    '@media (max-width: 560px)': { display: 'grid', gridAutoColumns: 'minmax(0, 1fr)', gridAutoFlow: 'column', width: '100%' },
  },
  option: {
    position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: '32px', boxSizing: 'border-box',
    paddingTop: '6px', paddingBottom: '6px', paddingLeft: '12px', paddingRight: '12px', borderRadius: '10px',
    color: h.muted, fontSize: '12.5px', lineHeight: '16px', fontWeight: tokens.fontWeightSemibold, textAlign: 'center', cursor: 'pointer',
    ':hover': { color: h.text },
    '&:has(input:focus-visible)': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
    '@media (max-width: 560px)': { paddingLeft: '8px', paddingRight: '8px' },
  },
  chosen: { color: h.text, backgroundColor: h.surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 10px -4px rgba(0, 0, 0, 0.14)' },
  // The radio stays in the accessibility tree and takes the keyboard; the segment around it is what the eye and the pointer use.
  input: { position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: 'pointer' },
});

/** A few mutually exclusive choices side by side, named by the element `labelledBy` points at. */
export function SegmentedChoice<T extends string>({ labelledBy, options, value, onChange, className }: {
  labelledBy: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const styles = useStyles();
  const name = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={mergeClasses(styles.group, className)}>
      {options.map((option) => (
        <label key={option.value} className={mergeClasses(styles.option, option.value === value && styles.chosen)}>
          <input type="radio" className={styles.input} name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}
