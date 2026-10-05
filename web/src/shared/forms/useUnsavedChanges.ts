import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

// The forms on screen that hold unsaved changes: the identity-confirmation dialog warns about them before it reloads the page.
const dirtyForms = new Set<symbol>();

/** True while some form on this page has changes that a full page reload would lose. */
export function hasUnsavedChanges(): boolean {
  return dirtyForms.size > 0;
}

/**
 * Asks before leaving a form with unsaved changes: in-app navigation through a dialog (`UnsavedChangesDialog`), closing
 * the tab through the browser's own prompt. Call `markSaved` right after a successful save so the redirect after it
 * does not ask.
 */
export function useUnsavedChanges(dirty: boolean) {
  const state = useRef({ dirty, saved: false });
  const token = useRef(Symbol('form'));
  useEffect(() => {
    state.current.dirty = dirty;
    if (dirty && !state.current.saved) dirtyForms.add(token.current);
    else dirtyForms.delete(token.current);
  });
  useEffect(() => {
    const own = token.current;
    return () => {
      dirtyForms.delete(own);
    };
  }, []);
  const isDirty = () => state.current.dirty && !state.current.saved;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => isDirty() && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search,
  );

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (isDirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const markSaved = useCallback(() => {
    state.current.saved = true;
    dirtyForms.delete(token.current);
  }, []);
  return { blocker, markSaved };
}
