import { useId, useRef } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { useReveal } from '../../app/motion';
import { SegmentedChoice } from '../../shared/components/SegmentedChoice';
import type { MyDayProfile } from './myDayProfile';

const useStyles = makeStyles({
  root: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', rowGap: '6px', marginLeft: 'auto', minWidth: 0, maxWidth: '100%' },
  label: { color: h.muted, fontSize: '12.5px', fontWeight: 700 },
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
  const root = useRef<HTMLDivElement>(null);
  // It rises with the section jumps beside it.
  useReveal(root, 'item', options.length > 1);
  if (options.length < 2) return null;
  return (<>
    <div ref={root} className={styles.root}>
      <span id={label} className={styles.label}>{t('myDay.layout.label')}</span>
      <SegmentedChoice labelledBy={label} options={options.map((option) => ({ value: option, label: t(`myDay.layout.${option}`) }))} value={value} onChange={onChange} />
    </div>
    <p role="status" className={failed ? styles.failed : styles.quiet}>{failed ? t('myDay.layout.saveFailed') : ''}</p>
  </>);
}
