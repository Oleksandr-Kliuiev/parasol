/** Keep a direct section URL visible while sibling panels load; never compete with user interaction. */
export function maintainSectionPosition(target: HTMLElement) {
  let active = true;
  const interactions = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => {
    if (!active) return;
    active = false; observer.disconnect();
    for (const event of interactions) window.removeEventListener(event, stop, true);
    target.removeEventListener('focusout', stop);
  };
  const observer = new ResizeObserver(() => {
    if (!active) return;
    if (document.activeElement !== target) { stop(); return; }
    target.scrollIntoView({ block: 'start' });
  });
  observer.observe(target.parentElement ?? target);
  for (const event of interactions) window.addEventListener(event, stop, { capture: true, passive: true });
  target.addEventListener('focusout', stop);
  return stop;
}
