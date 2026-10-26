/*
 * The controls a person used last, newest first: a dialog closed with Escape gives focus back to the one it was opened
 * from (shared/components/Dialog.tsx). Safari moves no focus to a button or link that is clicked, so a click counts as
 * well as focus; otherwise a dialog opened with the mouse in Safari would not know its button.
 */

const KEPT = 10;
const CONTROLS = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"]';

let used: WeakRef<HTMLElement>[] = [];

function remember(control: HTMLElement) {
  used = [new WeakRef(control), ...used.filter((entry) => {
    const element = entry.deref();
    return element !== undefined && element !== control;
  })].slice(0, KEPT);
}

/** Notes the controls a person focuses or clicks until the returned function is called. */
export function trackUsedControls(doc: Document = document) {
  const onFocusin = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) remember(event.target);
  };
  const onClick = (event: MouseEvent) => {
    const control = event.target instanceof Element ? event.target.closest(CONTROLS) : null;
    if (control instanceof HTMLElement) remember(control);
  };
  // Capture: the control is noted before its own click handler opens a dialog.
  doc.addEventListener('focusin', onFocusin, true);
  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('focusin', onFocusin, true);
    doc.removeEventListener('click', onClick, true);
    used = [];
  };
}

/** The controls used last that are still in the page, newest first. */
export function lastUsedControls() {
  return used.map((entry) => entry.deref()).filter((element): element is HTMLElement => element?.isConnected === true);
}
