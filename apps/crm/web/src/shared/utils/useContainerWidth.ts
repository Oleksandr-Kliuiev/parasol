import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The laid-out width of an element, followed on resize: for a list that chooses between a table and cards by its own room. The
 * window's width says too little where the side menu takes 232 or 256 px or none (AppShell). Zero until measured, and where
 * nothing is laid out (jsdom).
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
