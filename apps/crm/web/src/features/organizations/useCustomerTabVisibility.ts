import { useLayoutEffect, useRef } from 'react';
import { scrollEdgeInset } from '../../shared/utils/useScrollEdges';

/**
 * Reveal the URL-selected tab horizontally, without moving focus or the page vertically. The tab is found by its value, not by
 * aria-selected, which Fluent sets a render later than this effect runs; and the reveal runs again whenever the row or one of its
 * tabs changes size (the labels widen once the font has loaded), so on a narrow screen the selected tab never stays half outside.
 */
export function useCustomerTabVisibility(tab: string, scope: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!ready || !list) return;
    const tabs = () => [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const reveal = () => {
      // Compared, not put into a selector: the value comes from the address.
      const selected = tabs().find((element) => element.getAttribute('value') === tab);
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
    for (const element of tabs()) observer.observe(element);
    return () => observer.disconnect();
  }, [tab, scope, ready]);
  return ref;
}
