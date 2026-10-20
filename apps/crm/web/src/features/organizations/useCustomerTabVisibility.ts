import { useLayoutEffect, useRef } from 'react';
import { scrollEdgeInset } from '../../shared/utils/useScrollEdges';

/** Reveal the URL-selected tab horizontally, without moving focus or the page vertically. */
export function useCustomerTabVisibility(tab: string, scope: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!ready || !list) return;
    const reveal = () => {
      const selected = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!selected) return;
      const viewport = list.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      const offset = item.left < viewport.left + scrollEdgeInset ? item.left - viewport.left - scrollEdgeInset
        : item.right > viewport.right - scrollEdgeInset ? item.right - viewport.right + scrollEdgeInset : 0;
      if (offset !== 0) list.scrollBy({ left: offset, behavior: 'instant' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tab, scope, ready]);
  return ref;
}
