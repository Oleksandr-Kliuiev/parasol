import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';

function scrollOnKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  event.currentTarget.scrollBy({ left: direction * event.currentTarget.clientWidth * 0.75, behavior: 'instant' });
}

/**
 * A table region that is always a focusable, labelled region (unlike ScrollTable, which becomes one only while it
 * overflows): the specs and screen reader users find these tables by name at every width. The edges that hide more
 * columns fade, and the arrow keys scroll it, as in ScrollTable.
 */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref, 'x', label);
  return (
    <div ref={ref} className={className} style={edges.style} tabIndex={0} role="region" aria-label={label} onKeyDown={scrollOnKeyDown}>
      {children}
    </div>
  );
}
