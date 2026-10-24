import { useId, useRef } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { useReveal } from '../../app/motion';
import type { MyDayProfile } from './myDayProfile';

const useStyles = makeStyles({
  root: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', rowGap: '6px', marginLeft: 'auto', minWidth: 0, maxWidth: '100%' },
  label: { color: h.muted, fontSize: '12.5px', fontWeight: 700 },
  // The segmented control of the visual system (hearthSurfaces' tab list) over native radio buttons: one tab stop, arrow keys
  // move the choice, and a screen reader hears a group of three options with the one chosen.
  group: {
    display: 'inline-flex', gap: '2px', padding: '3px', borderRadius: '12px', backgroundColor: h.well, maxWidth: '100%', boxSizing: 'border-box',
    // On a phone the three choices share the width and a long label takes two lines instead of pushing the page sideways.
    '@media (max-width: 560px)': { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', width: '100%' },
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
  // A line of its own in the toolbar under the switch, so the switch and the section jumps keep their places when it shows.
  failed: { flexBasis: '100%', margin: 0, color: h.emberT, fontSize: '12.5px', lineHeight: '18px', textAlign: 'end' },
  // The status line stays mounted, so a failure is announced; empty, it takes no room in the toolbar.
  quiet: { position: 'absolute', width: '1px', height: '1px', margin: 0, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
});

/**
 * What My day shows first, chosen by the person (M38); one choice needs no switch, so none is shown then. The switch and its
 * status line are two items of the toolbar it sits in.
 */
export function MyDayLayoutSwitch({ options, value, onChange, failed }: {
  options: readonly MyDayProfile[]; value: MyDayProfile; onChange: (value: MyDayProfile) => void; failed: boolean;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const label = useId();
  const name = useId();
  const root = useRef<HTMLDivElement>(null);
  // It rises with the section jumps beside it.
  useReveal(root, 'item', options.length > 1);
  if (options.length < 2) return null;
  return (<>
    <div ref={root} className={styles.root}>
      <span id={label} className={styles.label}>{t('myDay.layout.label')}</span>
      <div role="radiogroup" aria-labelledby={label} className={styles.group}>
        {options.map((option) => (
          <label key={option} className={mergeClasses(styles.option, option === value && styles.chosen)}>
            <input type="radio" className={styles.input} name={name} value={option} checked={option === value} onChange={() => onChange(option)} />
            {t(`myDay.layout.${option}`)}
          </label>
        ))}
      </div>
    </div>
    <p role="status" className={failed ? styles.failed : styles.quiet}>{failed ? t('myDay.layout.saveFailed') : ''}</p>
  </>);
}
