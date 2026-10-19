/** Keep keyboard ownership across removal of a status button during its successful read refresh. */
export interface StatusFocusOwner {
  canRestore: () => boolean;
  restore: (replacement: HTMLButtonElement) => void;
  dispose: () => void;
}

export function captureStatusFocus(trigger: HTMLButtonElement, onDispose: () => void, isBlocked: () => boolean): StatusFocusOwner | null {
  const document = trigger.ownerDocument;
  const inaccessible = (element: Element | null) => Boolean(element?.closest('[aria-hidden="true"], [inert]'));
  const focusInDialog = () => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'));
  // A closed Fluent surface can remain in the DOM during exit motion. The editor's
  // current open state, rather than raw role presence, determines whether it owns focus.
  if (document.activeElement !== trigger || isBlocked() || focusInDialog() || inaccessible(trigger)) return null;
  let moved = false; let disposed = false;
  const inside = (target: EventTarget | null) => target instanceof Node && trigger.contains(target);
  const focus = (event: FocusEvent) => {
    if (event.target === document.body && !trigger.isConnected) return;
    if (!inside(event.target)) moved = true;
  };
  const pointer = (event: PointerEvent) => { if (!inside(event.target)) moved = true; };
  const key = (event: KeyboardEvent) => {
    if (!inside(event.target) || event.key === 'Tab' || event.key === 'Escape') moved = true;
  };
  const blur = () => queueMicrotask(() => { if (!disposed && trigger.isConnected) moved = true; });
  const visibility = () => { if (document.hidden) moved = true; };
  document.addEventListener('focusin', focus, true);
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', key, true);
  document.addEventListener('visibilitychange', visibility);
  trigger.addEventListener('blur', blur);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('focusin', focus, true);
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('visibilitychange', visibility);
    trigger.removeEventListener('blur', blur);
    onDispose();
  };
  const canRestore = () => !disposed && !moved && !document.hidden && !isBlocked() && !focusInDialog()
    && !(trigger.isConnected && inaccessible(trigger))
    && (document.activeElement === trigger || (!trigger.isConnected && document.activeElement === document.body));
  return { canRestore, dispose, restore: replacement => {
    const allowed = canRestore(); dispose(); if (allowed && replacement.isConnected && !inaccessible(replacement)) replacement.focus();
  } };
}
