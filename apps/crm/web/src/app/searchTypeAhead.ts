import { useEffect, useMemo, useRef } from 'react';

/** What the search palette's field needs from the shell's type-ahead. */
export interface SearchTypeAhead {
  /** The field has focus: returns the keys typed while the palette was loading; the field takes the rest itself. */
  take(): string;
  /** The field is gone: the next opening collects keys again. */
  release(): void;
}

/**
 * The search palette loads with its first use (ShellOverlays). Keys typed between opening it and its field taking focus
 * are kept and handed to the field; otherwise a quick "Ctrl K, name" loses the name, or types it into whatever had
 * focus on the page. Escape cancels the opening; a click anywhere drops what was collected and lets keys through again.
 */
export function useSearchTypeAhead(setOpen: (open: boolean) => void) {
  const state = useRef<{ pending: string | null; field: boolean }>({ pending: null, field: false });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const pending = state.current.pending;
      if (pending === null || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key === 'Escape') {
        state.current.pending = null;
        setOpen(false);
      } else if (event.key === 'Backspace') state.current.pending = pending.slice(0, -1);
      else if (event.key.length === 1) state.current.pending = pending + event.key;
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointer = () => {
      state.current.pending = null;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [setOpen]);

  return useMemo(
    () => ({
      /** The palette is opening: collect keys until its field has focus (unless the field is already there). */
      start() {
        if (!state.current.field) state.current.pending ??= '';
      },
      take() {
        const typed = state.current.pending ?? '';
        state.current = { pending: null, field: true };
        return typed;
      },
      release() {
        state.current = { pending: null, field: false };
      },
    }),
    [],
  );
}
