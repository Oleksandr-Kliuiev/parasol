import { useLayoutEffect, useRef } from 'react';
import { easeFn, flashValue, motionAllowed } from '../../app/motion';
import { parseFormattedNumber } from './formattedNumber';

/**
 * A figure that counts up from zero when it first appears and from the old value when it changes (then it also flashes).
 * The span is written directly, never through React children, so React never holds a text node the animation replaced.
 */
export function CountUp({ text, delay = 150 }: { text: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  // The value on screen once the last run finished; null until the first run has started.
  const shown = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const parsed = motionAllowed() ? parseFormattedNumber(text) : null;
    if (!parsed || shown.current === parsed.value || (shown.current === null && parsed.value === 0)) {
      element.textContent = text;
      shown.current = parsed?.value ?? shown.current;
      return;
    }
    const first = shown.current === null;
    const from = shown.current ?? 0;
    const duration = first ? 1400 : 900;
    const start = performance.now() + (first ? delay : 0);
    let started = false;
    let frame = 0;
    element.textContent = parsed.format(from);
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      if (t > 0) started = true;
      element.textContent = t >= 1 ? text : parsed.format(from + (parsed.value - from) * easeFn.out(t));
      if (t < 1) frame = requestAnimationFrame(step);
      else shown.current = parsed.value;
    };
    frame = requestAnimationFrame(step);
    if (!first) flashValue(element);
    return () => {
      cancelAnimationFrame(frame);
      element.textContent = text;
      // A run cut off before its first frame (React's double effects in development) starts again from the same place.
      if (started) shown.current = parsed.value;
    };
  }, [text, delay]);

  return <span ref={ref} style={{ display: 'inline-block' }} />;
}
