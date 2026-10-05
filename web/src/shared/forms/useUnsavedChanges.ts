import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

/**
 * Asks before leaving a form with unsaved changes: in-app navigation through a dialog (`UnsavedChangesDialog`), closing
 * the tab through the browser's own prompt. Call `markSaved` right after a successful save so the redirect after it
 * does not ask.
 */
export function useUnsavedChanges(dirty: boolean) {
  const state = useRef({ dirty, saved: false });
  useEffect(() => {
    state.current.dirty = dirty;
  });
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
  }, []);
  return { blocker, markSaved };
}
