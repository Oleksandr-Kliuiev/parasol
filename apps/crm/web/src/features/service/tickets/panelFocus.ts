/** A ref's current value, whichever React ref type holds it. */
interface Current<T> { readonly current: T }

/**
 * Puts focus on the first change a ticket's panel offers once a confirmation has closed and nothing took focus back. The
 * confirmation stays on the page while it fades out, and a browser that focuses a pressed button (WebKit on Linux) keeps focus on
 * its Close button until then: a single look after a fixed pause came too early on a slow machine, and focus fell to the page
 * behind afterwards. So the look repeats on each frame for a while and acts only once focus has fallen to the page. Focus that came
 * back into the panel by itself (on the button that asked) stays where it is, and so does focus in the next confirmation.
 */
export function keepFocusInPanel(bar: Current<HTMLElement | null>, asking: Current<boolean>, until = performance.now() + 3_000) {
  if (asking.current) return;
  const active = document.activeElement;
  if (active === null || active === document.body) {
    bar.current?.querySelector<HTMLElement>('button')?.focus();
    return;
  }
  if (bar.current?.closest('[role="dialog"]')?.contains(active)) return;
  if (performance.now() < until) requestAnimationFrame(() => keepFocusInPanel(bar, asking, until));
}
