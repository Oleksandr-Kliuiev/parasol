/*
 * WebKit (Safari 26) moves focus to a date, time or datetime-local field with a `focus` event and no `focusin`: on
 * focus() and on Tab, and a time field also on a click. Every other control, and Chromium and Firefox always, send
 * both. Fluent's tabster and keyborg learn about focus only from `focusin`, and so does React's onFocus. A dialog that
 * opens on such a field therefore never becomes the active modal: tabster sets aria-hidden on the dialog itself
 * (VoiceOver cannot read it, Playwright's getByRole finds nothing) and does not give focus back to the button that
 * opened it on close. Fluent's drawers and focus-trapping popovers depend on the same event.
 *
 * When focus lands on an element and no `focusin` follows for it, the missing one is sent once the browser has finished
 * moving focus, so a dialog may open on a date field. Browsers that send it are left alone.
 */

/** Sends the `focusin` a browser leaves out until the returned function is called. */
export function restoreMissingFocusin(doc: Document = document) {
  // The element the last focusin announced, until it loses focus.
  let announced: EventTarget | null = null;
  let stopped = false;

  const onFocusin = (event: FocusEvent) => {
    announced = event.target;
  };
  const onFocusout = (event: FocusEvent) => {
    if (event.target === announced) announced = null;
  };
  const onFocus = (event: FocusEvent) => {
    const { target, relatedTarget } = event;
    if (!(target instanceof Element)) return;
    // A browser that sends focusin does so right after focus, within the same task.
    setTimeout(() => {
      if (stopped || announced === target || doc.activeElement !== target) return;
      target.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget }));
    });
  };

  // Capture listeners on the document hear focus, which does not bubble, before the page's own handlers.
  doc.addEventListener('focusin', onFocusin, true);
  doc.addEventListener('focusout', onFocusout, true);
  doc.addEventListener('focus', onFocus, true);
  return () => {
    stopped = true;
    doc.removeEventListener('focusin', onFocusin, true);
    doc.removeEventListener('focusout', onFocusout, true);
    doc.removeEventListener('focus', onFocus, true);
  };
}
