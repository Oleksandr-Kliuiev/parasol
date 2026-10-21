import { useLayoutEffect, useRef, useState } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { ease, motionAllowed, reveal } from '../../app/motion';

const useStyles = makeStyles({
  // Letters rise out of their word, which clips them (the reference's title entrance).
  word: { display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.1em', marginBottom: '-0.1em' },
  letter: { display: 'inline-block' },
});

/** The title in letters while it rises, plain text again once it has landed. */
export function RisingTitle({ text }: { text: string }) {
  const styles = useStyles();
  const [split, setSplit] = useState(motionAllowed);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!split) return;
    const letters = ref.current?.querySelectorAll('[data-letter]') ?? [];
    const animations = reveal(letters, { yPercent: 115, rotate: 6, opacity: 1 }, {
      duration: 850,
      stagger: Math.min(22, 380 / Math.max(1, letters.length)),
      easing: ease.outStrong,
    });
    let active = true;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => active && setSplit(false),
      () => undefined,
    );
    return () => {
      active = false;
      animations.forEach((animation) => animation.cancel());
    };
  }, [split]);
  if (!split) return <>{text}</>;
  const words = text.split(' ');
  return (
    <span ref={ref}>
      {words.map((word, index) => (
        <span key={index}>
          <span className={styles.word}>
            {[...word].map((letter, position) => (
              <span key={position} className={styles.letter} data-letter>
                {letter}
              </span>
            ))}
          </span>
          {index < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </span>
  );
}

