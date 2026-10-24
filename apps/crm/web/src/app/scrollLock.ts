/*
 * Fluent locks the page under a modal (every dialog, the menu drawer) with `overflow-y: clip` and
 * `scrollbar-gutter: stable` on <html> and `overflow-y: hidden` on <body>. Two side effects show through the backdrop:
 * - Where scrollbars take room (Windows, Linux, macOS set to always show them), the stable gutter keeps the page where
 *   it was but stays empty: nothing in the page can paint there, so the backdrop, fixed to the viewport, ends where the
 *   scrollbar was and leaves a sharp, unblurred strip of the page at the right edge. Where the browser hides scrollbars
 *   (headless Chromium) the gutter even narrows the page by its width.
 * - <body> becomes a scroll container of its own, so on a scrolled page the sticky top bar and rail leave the window.
 *
 * While the lock is on, the page keeps the scrollbar's room as padding instead of the gutter, and <body> stays a plain
 * box (the lock on <html> alone stops the scrolling): the backdrop covers the whole window and nothing behind it moves.
 * `--h-locked-scrollbar` carries the scrollbar's width to the fixed layers that span the window (the glow, the phone tab
 * bar, the toasts), whose box grows by it while the lock is on.
 */

/**
 * Room a classic scrollbar takes; 0 where scrollbars overlay the page or are hidden. Read from the content box of a
 * scrolling probe, which keeps the fraction of a pixel that clientWidth rounds away under browser zoom.
 */
function scrollbarWidth() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position: fixed; top: 0; left: 0; width: 100px; height: 100px; overflow: scroll; visibility: hidden';
  const content = probe.appendChild(document.createElement('div'));
  document.body.append(probe);
  const width = 100 - content.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/** Follows Fluent's scroll lock on <html> until the returned function is called. */
export function watchScrollLock() {
  const html = document.documentElement;
  let adjusted = false;

  const release = () => {
    html.style.removeProperty('scrollbar-gutter');
    html.style.removeProperty('padding-right');
    html.style.removeProperty('--h-locked-scrollbar');
    document.body.style.removeProperty('overflow-y');
  };

  const sync = () => {
    const { overflowY } = getComputedStyle(html);
    const locked = overflowY === 'clip' || overflowY === 'hidden';
    if (locked === adjusted) return;
    adjusted = locked;
    if (!locked) return release();
    // Fluent locks only a page taller than the window, so until now the page showed a scrollbar of the browser's width.
    const width = `${scrollbarWidth()}px`;
    html.style.setProperty('scrollbar-gutter', 'auto');
    html.style.setProperty('padding-right', width);
    html.style.setProperty('--h-locked-scrollbar', width);
    document.body.style.setProperty('overflow-y', 'visible');
  };

  // The lock is a class on <html>; the callback runs before the next paint, so no frame shows the gutter.
  const observer = new MutationObserver(sync);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
    if (adjusted) release();
    adjusted = false;
  };
}
