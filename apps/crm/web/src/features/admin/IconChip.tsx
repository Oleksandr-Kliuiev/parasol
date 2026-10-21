import type { ReactElement } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { tone as tones, type Tone } from '../../app/hearth';

// Its own two classes, not the settings styles: the chip is part of the shell's first download (sign-in screens, banner).
const useStyles = makeStyles({
  chip: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '36px',
    height: '36px',
    borderRadius: '12px',
    '& svg': { width: '18px', height: '18px' },
  },
  small: { width: '32px', height: '32px', borderRadius: '10px', '& svg': { width: '16px', height: '16px' } },
});

/** A tinted square behind an icon, as on the integration cards of the reference. */
export function IconChip({ icon, tone = 'neutral', small, className }: { icon: ReactElement; tone?: Tone; small?: boolean; className?: string }) {
  const styles = useStyles();
  return (
    <span className={mergeClasses(styles.chip, small && styles.small, className)} style={{ backgroundColor: tones[tone].soft, color: tones[tone].text }} aria-hidden>
      {icon}
    </span>
  );
}
