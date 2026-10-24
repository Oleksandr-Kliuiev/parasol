import { useState } from 'react';

/**
 * Keeps what a dialog shows while it leaves. A caller closes its dialog by clearing the state the content comes from,
 * but the shared Dialog still plays its exit motion: content rendered from the cleared value would vanish at once,
 * leaving an empty box that shrinks away and dropping focus to the page. Open the dialog from the live value and render
 * its content from the returned one, which follows `value` while `open` holds and keeps the last such value after.
 *
 * `open` defaults to "the value is set". Pass state or a prop: an object built in the same render is new every time.
 */
export function useKeptWhileClosing<T>(value: T, open: boolean = value != null): T {
  const [kept, setKept] = useState(value);
  if (open && kept !== value) setKept(value);
  return open ? value : kept;
}
