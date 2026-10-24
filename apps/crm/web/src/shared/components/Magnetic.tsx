import type { ReactNode } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { ease, popIcon, useMagnetic } from '../../app/motion';

const useStyles = makeStyles({
  root: { display: 'inline-flex', transitionProperty: 'translate', transitionDuration: '0.5s', transitionTimingFunction: ease.out },
});

/**
 * Wraps an icon button that leans towards the pointer (the reference's top bar). `pop` also bounces the icon after a
 * click. The wrapper moves, so the button keeps its own transitions and focus ring.
 */
export function Magnetic({ children, pop = false, motion }: { children: ReactNode; pop?: boolean; motion?: string }) {
  const styles = useStyles();
  const ref = useMagnetic<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      className={styles.root}
      data-motion={motion}
      onClickCapture={pop ? (event) => popIcon((event.target as Element).closest('button')) : undefined}
    >
      {children}
    </span>
  );
}
