import { useLayoutEffect, useState, type RefObject } from 'react';

export const scrollEdgeInset = 16;

/** Fade only edges that conceal more content. At an end the last record stays fully readable. */
export function useScrollEdges<T extends HTMLElement>(ref: RefObject<T | null>, axis: 'x' | 'y', revision: unknown) {
  const [edges, setEdges] = useState({ before: false, after: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const maximum = Math.max(0, axis === 'x' ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight);
      const position = axis === 'y' ? element.scrollTop : getComputedStyle(element).direction === 'rtl'
        ? maximum + element.scrollLeft : element.scrollLeft;
      const before = position > 1, after = maximum - position > 1;
      setEdges(old => old.before === before && old.after === after ? old : { before, after });
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => { element.removeEventListener('scroll', measure); observer.disconnect(); };
  }, [ref, axis, revision]);
  const overflow = edges.before || edges.after;
  const start = edges.before ? `transparent, #000 ${scrollEdgeInset}px` : '#000';
  const end = edges.after ? `#000 calc(100% - ${scrollEdgeInset}px), transparent` : '#000';
  const mask = overflow ? `linear-gradient(to ${axis === 'x' ? 'right' : 'bottom'}, ${start}, ${end})` : undefined;
  return { overflow, style: { maskImage: mask, WebkitMaskImage: mask } };
}
