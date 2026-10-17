import { useLayoutEffect, useRef } from 'react';

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
      const offset = item.left < viewport.left ? item.left - viewport.left
        : item.right > viewport.right ? item.right - viewport.right : 0;
      if (offset !== 0) list.scrollBy({ left: offset, behavior: 'instant' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tab, scope, ready]);
  return ref;
}
